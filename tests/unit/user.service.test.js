const mockPrisma = {
  address: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  order: { count: jest.fn() },
  user: { findUnique: jest.fn() },
  // Every test here runs everything inside a single "transaction" whose tx
  // client is just mockPrisma itself — good enough to assert call shape
  // without standing up a real Mongo replica set for $transaction.
  $transaction: jest.fn((fn) => fn(mockPrisma)),
};
jest.mock('@config/prisma', () => mockPrisma);

const userService = require('@modules/user/user.service');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation((fn) => fn(mockPrisma));
});

describe('user.service', () => {
  describe('createAddress', () => {
    it("makes a user's first address the default even if isDefault wasn't passed", async () => {
      mockPrisma.address.count.mockResolvedValue(0);
      mockPrisma.address.create.mockResolvedValue({ id: 'addr1', isDefault: true });

      const result = await userService.createAddress({
        houseArea: '221B Baker St',
        user: { connect: { id: 'user1' } },
      });

      expect(mockPrisma.address.count).toHaveBeenCalledWith({ where: { userId: 'user1' } });
      expect(mockPrisma.address.create).toHaveBeenCalledWith({
        data: {
          houseArea: '221B Baker St',
          user: { connect: { id: 'user1' } },
          isDefault: true,
        },
      });
      // First address for this user — nothing else to clear.
      expect(mockPrisma.address.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'addr1', isDefault: true });
    });

    it('leaves a second address non-default unless isDefault: true is passed', async () => {
      mockPrisma.address.count.mockResolvedValue(1);
      mockPrisma.address.create.mockResolvedValue({ id: 'addr2', isDefault: false });

      await userService.createAddress({
        houseArea: '2nd address',
        user: { connect: { id: 'user1' } },
      });

      expect(mockPrisma.address.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ isDefault: false }),
      });
      expect(mockPrisma.address.updateMany).not.toHaveBeenCalled();
    });

    it('unsets every other default when isDefault: true is passed for a new address', async () => {
      mockPrisma.address.count.mockResolvedValue(1);
      mockPrisma.address.create.mockResolvedValue({ id: 'addr2', isDefault: true });

      await userService.createAddress({
        houseArea: '2nd address',
        isDefault: true,
        user: { connect: { id: 'user1' } },
      });

      expect(mockPrisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user1', isDefault: true, id: { not: 'addr2' } },
        data: { isDefault: false },
      });
    });
  });

  describe('getAddressesByUserId', () => {
    it("returns only the given user's addresses, default first then newest first", async () => {
      mockPrisma.address.findMany.mockResolvedValue([{ id: 'addr1' }]);

      const result = await userService.getAddressesByUserId('user1');

      expect(mockPrisma.address.findMany).toHaveBeenCalledWith({
        where: { userId: 'user1' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      expect(result).toEqual([{ id: 'addr1' }]);
    });
  });

  describe('updateAddressById', () => {
    it('rejects with 403 when the address does not belong to (or exist for) this user', async () => {
      mockPrisma.address.findFirst.mockResolvedValue(null);

      await expect(
        userService.updateAddressById('addr1', 'user1', { city: 'Pune' })
      ).rejects.toMatchObject({
        message: 'Address not found or unauthorized',
        statusCode: 403,
      });
      expect(mockPrisma.address.update).not.toHaveBeenCalled();
    });

    it('updates the address when it belongs to this user', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1' });
      mockPrisma.address.update.mockResolvedValue({ id: 'addr1', city: 'Pune' });

      const result = await userService.updateAddressById('addr1', 'user1', {
        city: 'Pune',
      });

      expect(mockPrisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr1' },
        data: { city: 'Pune' },
      });
      expect(mockPrisma.address.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'addr1', city: 'Pune' });
    });

    it('silently drops isDefault: false — un-defaulting only happens by making another address default', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1' });
      mockPrisma.address.update.mockResolvedValue({ id: 'addr1' });

      await userService.updateAddressById('addr1', 'user1', { city: 'Pune', isDefault: false });

      expect(mockPrisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr1' },
        data: { city: 'Pune' },
      });
      expect(mockPrisma.address.updateMany).not.toHaveBeenCalled();
    });

    it('clears every other default when isDefault: true is passed', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1' });
      mockPrisma.address.update.mockResolvedValue({ id: 'addr1', isDefault: true });

      await userService.updateAddressById('addr1', 'user1', { isDefault: true });

      expect(mockPrisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr1' },
        data: { isDefault: true },
      });
      expect(mockPrisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user1', isDefault: true, id: { not: 'addr1' } },
        data: { isDefault: false },
      });
    });
  });

  describe('deleteAddressById', () => {
    it('rejects with 401 when the address does not belong to (or exist for) this user', async () => {
      mockPrisma.address.findFirst.mockResolvedValue(null);

      await expect(
        userService.deleteAddressById('addr1', 'user1')
      ).rejects.toMatchObject({
        message: 'Address not found or unauthorized',
        statusCode: 401,
      });
      expect(mockPrisma.address.delete).not.toHaveBeenCalled();
    });

    it('deletes a non-default address without promoting anything', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1' });
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.address.delete.mockResolvedValue({ id: 'addr1', isDefault: false });

      const result = await userService.deleteAddressById('addr1', 'user1');

      expect(mockPrisma.order.count).toHaveBeenCalledWith({ where: { addressId: 'addr1' } });
      expect(mockPrisma.address.delete).toHaveBeenCalledWith({ where: { id: 'addr1' } });
      expect(mockPrisma.address.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.address.update).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'addr1', isDefault: false });
    });

    it('promotes the next most recent address to default when the default one is deleted', async () => {
      mockPrisma.address.findFirst
        .mockResolvedValueOnce({ id: 'addr1', userId: 'user1' }) // ownership check
        .mockResolvedValueOnce({ id: 'addr2', userId: 'user1' }); // "next" lookup
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.address.delete.mockResolvedValue({ id: 'addr1', isDefault: true });
      mockPrisma.address.update.mockResolvedValue({ id: 'addr2', isDefault: true });

      await userService.deleteAddressById('addr1', 'user1');

      expect(mockPrisma.address.findFirst).toHaveBeenNthCalledWith(2, {
        where: { userId: 'user1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr2' },
        data: { isDefault: true },
      });
    });

    it('leaves no address to promote when the default one deleted was the last address', async () => {
      mockPrisma.address.findFirst
        .mockResolvedValueOnce({ id: 'addr1', userId: 'user1' })
        .mockResolvedValueOnce(null);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.address.delete.mockResolvedValue({ id: 'addr1', isDefault: true });

      await userService.deleteAddressById('addr1', 'user1');

      expect(mockPrisma.address.update).not.toHaveBeenCalled();
    });

    it('rejects with 409 and never deletes when the address is linked to a past order', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1' });
      mockPrisma.order.count.mockResolvedValue(2);

      await expect(
        userService.deleteAddressById('addr1', 'user1')
      ).rejects.toMatchObject({
        message: 'This address is linked to past orders and cannot be deleted. You can add a new address instead.',
        statusCode: 409,
      });
      expect(mockPrisma.order.count).toHaveBeenCalledWith({ where: { addressId: 'addr1' } });
      expect(mockPrisma.address.delete).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('setDefaultAddressById', () => {
    it('rejects with 403 when the address does not belong to (or exist for) this user', async () => {
      mockPrisma.address.findFirst.mockResolvedValue(null);

      await expect(
        userService.setDefaultAddressById('addr1', 'user1')
      ).rejects.toMatchObject({
        message: 'Address not found or unauthorized',
        statusCode: 403,
      });
    });

    it('is a no-op when the address is already the default', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1', isDefault: true });

      const result = await userService.setDefaultAddressById('addr1', 'user1');

      expect(mockPrisma.address.update).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'addr1', userId: 'user1', isDefault: true });
    });

    it('sets the address as default and clears every other default', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1', isDefault: false });
      mockPrisma.address.update.mockResolvedValue({ id: 'addr1', isDefault: true });

      const result = await userService.setDefaultAddressById('addr1', 'user1');

      expect(mockPrisma.address.update).toHaveBeenCalledWith({
        where: { id: 'addr1' },
        data: { isDefault: true },
      });
      expect(mockPrisma.address.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user1', isDefault: true, id: { not: 'addr1' } },
        data: { isDefault: false },
      });
      expect(result).toEqual({ id: 'addr1', isDefault: true });
    });
  });

  describe('getUserProfile', () => {
    // Regression test: this used an unimported `CustomError` (capitalized)
    // instead of the imported `customError`, so a missing user threw a raw
    // ReferenceError instead of a clean 404.
    it('rejects with a proper 404 CustomError when the user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(userService.getUserProfile('missing-user')).rejects.toMatchObject({
        message: 'User not found',
        statusCode: 404,
      });
    });

    it('returns the selected profile fields for an existing user', async () => {
      const profile = {
        id: 'user1',
        name: 'Jane',
        email: 'jane@x.com',
        phone: '+919876543210',
        createdAt: new Date('2026-01-01'),
      };
      mockPrisma.user.findUnique.mockResolvedValue(profile);

      const result = await userService.getUserProfile('user1');

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user1' },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          createdAt: true,
        },
      });
      expect(result).toEqual(profile);
    });
  });
});
