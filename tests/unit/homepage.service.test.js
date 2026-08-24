const mockPrisma = {
  banner: { create: jest.fn(), delete: jest.fn() },
  product: { update: jest.fn() },
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

const homepageService = require('@modules/homepage/homepage.service');

describe('homepage.service', () => {
  beforeEach(() => {
    mockPrisma.banner.create.mockReset();
    mockPrisma.banner.delete.mockReset();
    mockPrisma.product.update.mockReset();
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.scan.mockReset().mockResolvedValue(['0', []]);
    mockRedis.del.mockReset();
  });

  describe('createNewBanner', () => {
    it('invalidates the banners cache after creating, so GET /homepage/banners stops serving the pre-create list', async () => {
      mockPrisma.banner.create.mockResolvedValue({
        id: 'b1',
        imageUrl: 'img.jpg',
        linkUrl: null,
      });
      mockRedis.scan.mockResolvedValue(['0', ['banners:{}']]);

      const banner = await homepageService.createNewBanner('img.jpg', null);

      expect(banner).toEqual({ id: 'b1', imageUrl: 'img.jpg', linkUrl: null });
      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'banners:*',
        'COUNT',
        100
      );
      expect(mockRedis.del).toHaveBeenCalledWith('banners:{}');
    });
  });

  describe('deleteBannerById', () => {
    it('invalidates the banners cache after deleting', async () => {
      mockPrisma.banner.delete.mockResolvedValue({ id: 'b1' });

      await homepageService.deleteBannerById('b1');

      expect(mockPrisma.banner.delete).toHaveBeenCalledWith({
        where: { id: 'b1' },
      });
      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'banners:*',
        'COUNT',
        100
      );
    });
  });

  describe('softDeleteNewArrivalService', () => {
    it('invalidates the newArrivalProducts cache after flipping isNewArrival off, so GET /homepage/new-arrivals stops serving the stale list', async () => {
      mockPrisma.product.update.mockResolvedValue({
        id: 'p1',
        isNewArrival: false,
      });

      await homepageService.softDeleteNewArrivalService('p1');

      expect(mockPrisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { isNewArrival: false },
      });
      expect(mockRedis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'newArrivalProducts:*',
        'COUNT',
        100
      );
    });
  });
});
