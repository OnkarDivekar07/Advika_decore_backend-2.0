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

const mockAwsService = { uploadToS3: jest.fn() };
jest.mock('../../src/services/external/AWSUploads', () => mockAwsService);

const mockCompressImageBuffer = jest.fn();
jest.mock('@utils/imageUtils', () => ({ compressImageBuffer: mockCompressImageBuffer }));

jest.mock('@utils/bannerHelpers', () => ({
  generateUniqueProductFilenames: jest.fn((names) =>
    names.map((n) => `product-images/fixed_${n}.webp`)
  ),
}));

const mockPrisma = {
  product: { create: jest.fn(), update: jest.fn() },
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
    mockAwsService.uploadToS3.mockReset().mockResolvedValue('https://cdn.example.com/img.webp');
    mockCompressImageBuffer.mockReset().mockResolvedValue(Buffer.from('compressed'));
    mockPrisma.product.create.mockReset();
    mockPrisma.product.update.mockReset();
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
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith('newArrivalProducts');
      expect(result).toEqual({
        id: 'p1',
        images: ['https://cdn.example.com/img.webp', 'https://cdn.example.com/img.webp'],
      });
    });

    it('throws when images is not an array', async () => {
      await expect(
        processor({ name: 'create-product', data: { serializedImages: null, productInfo: {} } })
      ).rejects.toThrow('images should be an array');
      expect(mockPrisma.product.create).not.toHaveBeenCalled();
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
        data: { name: 'New name', images: ['https://cdn.example.com/img.webp'] },
      });
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith('allProducts');
      expect(mockInvalidateCacheByPrefix).toHaveBeenCalledWith('newArrivalProducts');
      expect(result).toEqual({ id: 'p1', images: ['https://cdn.example.com/img.webp'] });
    });

    it('updates without touching images when none are provided', async () => {
      mockPrisma.product.update.mockResolvedValue({ id: 'p1' });

      const result = await processor({
        name: 'update-product',
        data: { productId: 'p1', serializedImages: [], updateData: { price: 1999 } },
      });

      expect(mockPrisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { price: 1999 },
      });
      expect(result).toEqual({ id: 'p1', images: [] });
    });
  });

  it('rejects unknown job names', async () => {
    await expect(processor({ name: 'delete-product', data: {} })).rejects.toThrow(
      'Unknown job type: delete-product'
    );
  });
});
