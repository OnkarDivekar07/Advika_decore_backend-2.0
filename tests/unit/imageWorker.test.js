// The worker instantiates `new Worker(name, processor, opts)` at module
// load time. Mocking bullmq lets us capture the `processor` function it
// was given and invoke it directly, exercising the real business logic
// without a live Redis/BullMQ connection.
const mockWorkerOn = jest.fn();
const MockWorker = jest.fn().mockImplementation((name, processor) => ({
  name,
  processor,
  on: mockWorkerOn,
}));
jest.mock('bullmq', () => ({ Worker: MockWorker }));

jest.mock('@config/redis', () => ({}));

const mockAwsService = {
  uploadToS3: jest.fn(),
  deleteFromS3: jest.fn(),
  keyFromPublicUrl: jest.fn((url) => (url ? `key-for/${url}` : null)),
};
jest.mock('../../src/services/external/AWSUploads', () => mockAwsService);

const mockCompressImageBuffer = jest.fn();
jest.mock('@utils/imageUtils', () => ({
  compressImageBuffer: mockCompressImageBuffer,
}));

jest.mock('@utils/bannerHelpers', () => ({
  generateUniqueProductFilenames: jest.fn((names) =>
    names.map((n) => `product-images/fixed_${n}.webp`)
  ),
}));

const mockPrisma = {
  product: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
};
jest.mock('@config/prisma', () => mockPrisma);

const mockInvalidateCacheByPrefix = jest.fn();
jest.mock('@utils/invalidateCacheByPrefix', () => mockInvalidateCacheByPrefix);

jest.mock('@modules/product/product.service', () => ({
  PRODUCT_CACHE_PREFIXES: ['allProducts', 'newArrivalProducts'],
}));

require('../../src/jobs/workers/imageWorker');
const processor = MockWorker.mock.calls[0][1];

const buildImage = (name = 'shoe.jpg') => ({
  originalname: name,
  mimetype: 'image/jpeg',
  buffer: Buffer.from('fake-bytes').toString('base64'),
});

describe('imageWorker', () => {
  beforeEach(() => {
    mockAwsService.uploadToS3
      .mockReset()
      .mockResolvedValue('https://cdn.example.com/img.webp');
    mockAwsService.deleteFromS3.mockReset().mockResolvedValue(undefined);
    mockAwsService.keyFromPublicUrl.mockReset().mockImplementation((url) =>
      url ? `key-for/${url}` : null
    );
    mockCompressImageBuffer
      .mockReset()
      .mockResolvedValue(Buffer.from('compressed'));
    mockPrisma.product.create.mockReset();
    mockPrisma.product.update.mockReset();
    mockPrisma.product.findUnique.mockReset().mockResolvedValue({ images: [] });
    mockInvalidateCacheByPrefix.mockReset();
  });

  describe('create-product', () => {
    it('uploads every image, creates the product, invalidates caches, and returns { id, images }', async () => {
      mockPrisma.product.create.mockResolvedValue({ id: 'p1' });

      const result = await processor({
        name: 'create-product',
        data: {
          serializedImages: [buildImage('a.jpg'), buildImage('b.jpg')],
          productInfo: { name: 'Trail Runner', price: '2999', stock: '15' },
        },
      });

      expect(mockAwsService.uploadToS3).toHaveBeenCalledTimes(2);
      expect(mockPrisma.product.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Trail Runner',
          price: 2999,
          stock: 15,
          images: [
            'https://cdn.example.com/img.webp',
            'https://cdn.example.com/img.webp',
          ],
        }),
      });
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith('allProducts');
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith(
        'newArrivalProducts'
      );
      expect(result).toEqual({
        id: 'p1',
        images: [
          'https://cdn.example.com/img.webp',
          'https://cdn.example.com/img.webp',
        ],
      });
    });

    it('throws when images is not an array', async () => {
      await expect(
        processor({
          name: 'create-product',
          data: { serializedImages: null, productInfo: {} },
        })
      ).rejects.toThrow('images should be an array');
      expect(mockPrisma.product.create).not.toHaveBeenCalled();
    });

    // Pattern 15 (R2/S3 migration audit): "R2 outage does not corrupt
    // unrelated product data" — an upload failing partway through a
    // multi-image create must never leave a half-written product row (some
    // images uploaded, others not) or touch any other product.
    it('never creates the product if an R2 upload fails partway through', async () => {
      mockAwsService.uploadToS3
        .mockResolvedValueOnce('https://cdn.example.com/img.webp')
        .mockRejectedValueOnce(new Error('R2 unavailable'));

      await expect(
        processor({
          name: 'create-product',
          data: {
            serializedImages: [buildImage('a.jpg'), buildImage('b.jpg')],
            productInfo: { name: 'Trail Runner', price: '2999', stock: '15' },
          },
        })
      ).rejects.toThrow('R2 unavailable');

      expect(mockPrisma.product.create).not.toHaveBeenCalled();
      expect(mockInvalidateCacheByPrefix).not.toHaveBeenCalled();
    });
  });

  describe('update-product', () => {
    it('updates the product by its real id, invalidates caches, and returns { id, images }', async () => {
      mockPrisma.product.update.mockResolvedValue({ id: 'p1' });

      const result = await processor({
        name: 'update-product',
        data: {
          productId: 'p1',
          serializedImages: [buildImage('c.jpg')],
          updateData: { name: 'New name' },
        },
      });

      expect(mockPrisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: {
          name: 'New name',
          images: ['https://cdn.example.com/img.webp'],
        },
      });
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith('allProducts');
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith(
        'newArrivalProducts'
      );
      expect(result).toEqual({
        id: 'p1',
        images: ['https://cdn.example.com/img.webp'],
      });
    });

    it('updates without touching images when none are provided', async () => {
      mockPrisma.product.update.mockResolvedValue({ id: 'p1' });

      const result = await processor({
        name: 'update-product',
        data: {
          productId: 'p1',
          serializedImages: [],
          updateData: { price: 1999 },
        },
      });

      expect(mockPrisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { price: 1999 },
      });
      expect(result).toEqual({ id: 'p1', images: [] });
      // No images were being replaced, so there's nothing to clean up.
      expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
      expect(mockAwsService.deleteFromS3).not.toHaveBeenCalled();
    });

    // Pattern 14 (product CRUD/media audit): replacing a product's images
    // on update previously never cleaned up the ones it superseded —
    // every replaced image became a permanently orphaned R2 object.
    it('deletes the superseded images from R2 after a successful update that replaces images', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({
        images: ['https://cdn.example.com/old-1.webp', 'https://cdn.example.com/old-2.webp'],
      });
      mockPrisma.product.update.mockResolvedValue({ id: 'p1' });

      await processor({
        name: 'update-product',
        data: {
          productId: 'p1',
          serializedImages: [buildImage('new.jpg')],
          updateData: { name: 'New name' },
        },
      });

      expect(mockPrisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: 'p1' },
        select: { images: true },
      });
      expect(mockAwsService.deleteFromS3).toHaveBeenCalledTimes(2);
      expect(mockAwsService.deleteFromS3).toHaveBeenCalledWith(
        'key-for/https://cdn.example.com/old-1.webp'
      );
      expect(mockAwsService.deleteFromS3).toHaveBeenCalledWith(
        'key-for/https://cdn.example.com/old-2.webp'
      );
    });

    it('does not fail the update when cleaning up a superseded image fails (best-effort)', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({
        images: ['https://cdn.example.com/old-1.webp'],
      });
      mockPrisma.product.update.mockResolvedValue({ id: 'p1' });
      mockAwsService.deleteFromS3.mockRejectedValue(new Error('R2 unavailable'));

      const result = await processor({
        name: 'update-product',
        data: {
          productId: 'p1',
          serializedImages: [buildImage('new.jpg')],
          updateData: {},
        },
      });

      // The update itself still succeeded and returned normally — a
      // cleanup failure must never surface as a job failure (which would
      // retry the whole handler and risk re-running the Prisma update /
      // re-uploading images).
      expect(result).toEqual({
        id: 'p1',
        images: ['https://cdn.example.com/img.webp'],
      });
    });

    // Pattern 15 (R2/S3 migration audit): an upload failure on an update
    // must leave the product exactly as it was — no Prisma write of any
    // kind, and (crucially) no deletion of the product's still-current
    // images, since deleteSupersededImages must never run without a
    // confirmed-successful replacement.
    it('never updates the product or touches its existing images if a new-image R2 upload fails', async () => {
      mockAwsService.uploadToS3.mockRejectedValue(new Error('R2 unavailable'));

      await expect(
        processor({
          name: 'update-product',
          data: {
            productId: 'p1',
            serializedImages: [buildImage('new.jpg')],
            updateData: { name: 'New name' },
          },
        })
      ).rejects.toThrow('R2 unavailable');

      expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.product.update).not.toHaveBeenCalled();
      expect(mockAwsService.deleteFromS3).not.toHaveBeenCalled();
      expect(mockInvalidateCacheByPrefix).not.toHaveBeenCalled();
    });
  });

  it('rejects unknown job names', async () => {
    await expect(
      processor({ name: 'delete-product', data: {} })
    ).rejects.toThrow('Unknown job type: delete-product');
  });
});
