const mockPrisma = {
  product: {
    count: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};
jest.mock('@config/prisma', () => mockPrisma);

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  // invalidateCacheByPrefix walks the keyspace with SCAN then DEL — an
  // empty first page (cursor '0', no keys) is a safe default so tests
  // that don't care about cache invalidation don't need to stub this.
  scan: jest.fn().mockResolvedValue(['0', []]),
  del: jest.fn(),
};
jest.mock('@config/redis', () => mockRedis);

const mockImageQueue = { add: jest.fn(), getJob: jest.fn() };
jest.mock('../../src/jobs/queues/imageQueue', () => mockImageQueue);

const productService = require('@modules/product/product.service');

describe('product.service', () => {
  beforeEach(() => {
    Object.values(mockPrisma.product).forEach((fn) => fn.mockReset());
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.scan.mockReset().mockResolvedValue(['0', []]);
    mockRedis.del.mockReset();
    mockImageQueue.add.mockReset();
    mockImageQueue.getJob.mockReset();
  });

  describe('getAllProducts', () => {
    it('lists only non-deleted products, cached', async () => {
      mockPrisma.product.count.mockResolvedValue(2);
      mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
      mockRedis.get.mockResolvedValue(null);

      const result = await productService.getAllProducts({ query: {} });

      expect(result.data).toHaveLength(2);
      const callArgs = mockPrisma.product.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ isDeleted: false });
      expect(mockRedis.set).toHaveBeenCalled(); // cache: true for this listing
    });

    it('returns a cached page without hitting Prisma', async () => {
      const cached = { data: [{ id: 'cached' }], meta: { total: 1 } };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await productService.getAllProducts({ query: {} });

      expect(result).toEqual(cached);
      expect(mockPrisma.product.findMany).not.toHaveBeenCalled();
    });

    it('filters by category using hasSome, since category is a String[] field', async () => {
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockRedis.get.mockResolvedValue(null);

      await productService.getAllProducts({ query: { category: 'Truck, Tempo' } });

      const callArgs = mockPrisma.product.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({
        isDeleted: false,
        category: { hasSome: ['Truck', 'Tempo'] },
      });
    });

    it('filters by price range', async () => {
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockRedis.get.mockResolvedValue(null);

      await productService.getAllProducts({ query: { minPrice: '100', maxPrice: '500' } });

      const callArgs = mockPrisma.product.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ isDeleted: false, price: { gte: 100, lte: 500 } });
    });

    it('filters by inStock', async () => {
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockRedis.get.mockResolvedValue(null);

      await productService.getAllProducts({ query: { inStock: 'true' } });

      const callArgs = mockPrisma.product.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ isDeleted: false, stock: { gt: 0 } });
    });

    it('filters by isNewArrival', async () => {
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockRedis.get.mockResolvedValue(null);

      await productService.getAllProducts({ query: { isNewArrival: 'true' } });

      const callArgs = mockPrisma.product.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ isDeleted: false, isNewArrival: true });
    });

    it('caches different category filters under different keys (no cross-filter bleed)', async () => {
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockRedis.get.mockResolvedValue(null);

      await productService.getAllProducts({ query: { category: 'Truck' } });
      await productService.getAllProducts({ query: { category: 'Car' } });

      const keysWritten = mockRedis.set.mock.calls.map((call) => call[0]);
      expect(keysWritten[0]).not.toEqual(keysWritten[1]);
    });

    it('filters by brand via the generic filterableFields mechanism', async () => {
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockRedis.get.mockResolvedValue(null);

      await productService.getAllProducts({ query: { brand: 'Advika' } });

      const callArgs = mockPrisma.product.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ brand: 'Advika' });
    });
  });

  describe('getProductById', () => {
    it('400s when no id is given', async () => {
      await expect(productService.getProductById(undefined)).rejects.toMatchObject({
        message: 'Product ID is required',
        statusCode: 400,
      });
    });

    it('404s when the product does not exist', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);

      await expect(productService.getProductById('missing')).rejects.toMatchObject({
        message: 'Product not found',
        statusCode: 404,
      });
    });

    it('returns the product when found', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1', name: 'Shirt' });

      const result = await productService.getProductById('p1');
      expect(result).toEqual({ id: 'p1', name: 'Shirt' });
    });
  });

  describe('getProductsByIds', () => {
    it('returns an empty array without querying prisma when given no ids', async () => {
      const result = await productService.getProductsByIds([]);

      expect(result).toEqual([]);
      expect(mockPrisma.product.findMany).not.toHaveBeenCalled();
    });

    it('queries only non-deleted products matching the given ids', async () => {
      mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);

      const result = await productService.getProductsByIds(['p1', 'p2', 'p_deleted']);

      expect(mockPrisma.product.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['p1', 'p2', 'p_deleted'] }, isDeleted: false },
      });
      expect(result).toEqual([{ id: 'p1' }, { id: 'p2' }]);
    });
  });

  describe('getRelatedProducts', () => {
    it('404s when the source product does not exist', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);

      await expect(
        productService.getRelatedProducts('missing')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('404s when the source product has no category', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ category: [] });

      await expect(
        productService.getRelatedProducts('p1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('returns up to 4 products sharing a category, excluding the original', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ category: ['shirts'] });
      mockPrisma.product.findMany.mockResolvedValue([{ id: 'p2' }, { id: 'p3' }]);

      const result = await productService.getRelatedProducts('p1');

      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isDeleted: false,
            category: { hasSome: ['shirts'] },
            id: { not: 'p1' },
          }),
          take: 4,
        })
      );
      expect(result).toEqual([{ id: 'p2' }, { id: 'p3' }]);
    });
  });

  describe('deleteProduct', () => {
    it('404s when the product does not exist', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);

      await expect(productService.deleteProduct('missing')).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockPrisma.product.update).not.toHaveBeenCalled();
    });

    it('soft-deletes an existing product (isDeleted: true, not a hard delete)', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1' });
      mockPrisma.product.update.mockResolvedValue({ id: 'p1', isDeleted: true });

      await productService.deleteProduct('p1');

      expect(mockPrisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { isDeleted: true },
      });
    });

    it('invalidates the allProducts and newArrivalProducts caches after deleting', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1' });
      mockPrisma.product.update.mockResolvedValue({ id: 'p1', isDeleted: true });
      mockRedis.scan.mockResolvedValue(['0', ['allProducts:{}', 'newArrivalProducts:{}']]);

      await productService.deleteProduct('p1');

      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'allProducts:*',
        'COUNT',
        100
      );
      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'newArrivalProducts:*',
        'COUNT',
        100
      );
      expect(mockRedis.del).toHaveBeenCalledWith('allProducts:{}', 'newArrivalProducts:{}');
    });
  });

  describe('getProductJobStatus', () => {
    it('400s when no jobId is given', async () => {
      await expect(productService.getProductJobStatus(undefined)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('404s when the job does not exist', async () => {
      mockImageQueue.getJob.mockResolvedValue(null);

      await expect(productService.getProductJobStatus('missing')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('returns the result payload once the job has completed', async () => {
      mockImageQueue.getJob.mockResolvedValue({
        id: 'job1',
        getState: jest.fn().mockResolvedValue('completed'),
        returnvalue: { id: 'p1', images: ['https://cdn/img.webp'] },
      });

      const result = await productService.getProductJobStatus('job1');

      expect(result).toEqual({
        jobId: 'job1',
        state: 'completed',
        result: { id: 'p1', images: ['https://cdn/img.webp'] },
      });
    });

    it('surfaces the failure reason when the job has failed', async () => {
      mockImageQueue.getJob.mockResolvedValue({
        id: 'job1',
        getState: jest.fn().mockResolvedValue('failed'),
        failedReason: 'S3 upload timed out',
      });

      const result = await productService.getProductJobStatus('job1');

      expect(result).toEqual({
        jobId: 'job1',
        state: 'failed',
        failedReason: 'S3 upload timed out',
      });
    });

    it('reports in-progress states without a result yet', async () => {
      mockImageQueue.getJob.mockResolvedValue({
        id: 'job1',
        getState: jest.fn().mockResolvedValue('active'),
      });

      const result = await productService.getProductJobStatus('job1');

      expect(result).toEqual({ jobId: 'job1', state: 'active' });
    });
  });

  describe('queueProductCreation', () => {
    it('rejects with 400 when no images are provided', async () => {
      await expect(
        productService.queueProductCreation({ name: 'Shirt' }, [])
      ).rejects.toMatchObject({ message: 'No images uploaded', statusCode: 400 });
      expect(mockImageQueue.add).not.toHaveBeenCalled();
    });

    it('base64-serializes images and queues a create-product job', async () => {
      mockImageQueue.add.mockResolvedValue({ id: 'job1' });
      const images = [
        { originalname: 'a.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('abc') },
      ];

      const job = await productService.queueProductCreation({ name: 'Shirt' }, images);

      expect(mockImageQueue.add).toHaveBeenCalledWith('create-product', {
        serializedImages: [
          {
            originalname: 'a.jpg',
            mimetype: 'image/jpeg',
            buffer: Buffer.from('abc').toString('base64'),
          },
        ],
        productInfo: { name: 'Shirt' },
      });
      expect(job).toEqual({ id: 'job1' });
    });
  });

  describe('queueProductUpdate', () => {
    it('queues with no images when none are given (no validation error)', async () => {
      mockImageQueue.add.mockResolvedValue({ id: 'job2' });

      await productService.queueProductUpdate('p1', { name: 'New name' }, []);

      expect(mockImageQueue.add).toHaveBeenCalledWith('update-product', {
        productId: 'p1',
        updateData: { name: 'New name' },
        serializedImages: [],
      });
    });

    it('validates and serializes images when provided', async () => {
      mockImageQueue.add.mockResolvedValue({ id: 'job3' });
      const images = [
        { originalname: 'b.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('xyz') },
      ];

      await productService.queueProductUpdate('p1', { name: 'New name' }, images);

      const call = mockImageQueue.add.mock.calls[0][1];
      expect(call.serializedImages).toEqual([
        {
          originalname: 'b.jpg',
          mimetype: 'image/jpeg',
          buffer: Buffer.from('xyz').toString('base64'),
        },
      ]);
    });
  });
});
