const mockPrisma = {
  siteContent: { findMany: jest.fn(), upsert: jest.fn() },
};
jest.mock('@config/prisma', () => mockPrisma);

const contentService = require('@modules/content/content.service');

describe('content.service', () => {
  beforeEach(() => {
    mockPrisma.siteContent.findMany.mockReset();
    mockPrisma.siteContent.upsert.mockReset();
  });

  describe('getAllContent', () => {
    it('lists every row ordered by key', async () => {
      mockPrisma.siteContent.findMany.mockResolvedValue([{ key: 'ticker.cod' }]);

      const result = await contentService.getAllContent();

      expect(mockPrisma.siteContent.findMany).toHaveBeenCalledWith({
        orderBy: { key: 'asc' },
      });
      expect(result).toEqual([{ key: 'ticker.cod' }]);
    });
  });

  describe('upsertContent', () => {
    it('rejects when any language value is missing, without touching the database', async () => {
      await expect(
        contentService.upsertContent('ticker.cod', {
          valueEn: 'a',
          valueHi: '',
          valueMr: 'c',
        })
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(mockPrisma.siteContent.upsert).not.toHaveBeenCalled();
    });

    it('upserts by key, creating the row if it does not exist yet', async () => {
      mockPrisma.siteContent.upsert.mockResolvedValue({
        key: 'ticker.cod',
        valueEn: 'a',
        valueHi: 'b',
        valueMr: 'c',
      });

      const result = await contentService.upsertContent('ticker.cod', {
        valueEn: 'a',
        valueHi: 'b',
        valueMr: 'c',
      });

      expect(mockPrisma.siteContent.upsert).toHaveBeenCalledWith({
        where: { key: 'ticker.cod' },
        update: { valueEn: 'a', valueHi: 'b', valueMr: 'c' },
        create: { key: 'ticker.cod', valueEn: 'a', valueHi: 'b', valueMr: 'c' },
      });
      expect(result.key).toBe('ticker.cod');
    });
  });
});
