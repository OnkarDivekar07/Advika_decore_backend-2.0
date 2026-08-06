const mockPrisma = {
  address: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  user: { findUnique: jest.fn() },
};
jest.mock('@config/prisma', () => mockPrisma);

const userService = require('@modules/user/user.service');

describe('user.service', () => {
  describe('createAddress', () => {
    it('creates an address with the given data', async () => {
      mockPrisma.address.create.mockResolvedValue({ id: 'addr1' });

      const result = await userService.createAddress({
        houseArea: '221B Baker St',
        user: { connect: { id: 'user1' } },
      });

      expect(mockPrisma.address.create).toHaveBeenCalledWith({
        data: { houseArea: '221B Baker St', user: { connect: { id: 'user1' } } },
      });
      expect(result).toEqual({ id: 'addr1' });
    });
  });

  describe('getAddressesByUserId', () => {
    it("returns only the given user's addresses", async () => {
      mockPrisma.address.findMany.mockResolvedValue([{ id: 'addr1' }]);

      const result = await userService.getAddressesByUserId('user1');

      expect(mockPrisma.address.findMany).toHaveBeenCalledWith({
        where: { userId: 'user1' },
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
      expect(result).toEqual({ id: 'addr1', city: 'Pune' });
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

    it('deletes the address when it belongs to this user', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'addr1', userId: 'user1' });
      mockPrisma.address.delete.mockResolvedValue({ id: 'addr1' });

      const result = await userService.deleteAddressById('addr1', 'user1');

      expect(mockPrisma.address.delete).toHaveBeenCalledWith({
        where: { id: 'addr1' },
      });
      expect(result).toEqual({ id: 'addr1' });
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
        address: [],
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
          address: true,
          createdAt: true,
        },
      });
      expect(result).toEqual(profile);
    });
  });
});
