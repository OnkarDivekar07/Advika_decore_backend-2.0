const prisma = require('@config/prisma');
const customError = require('@utils/customError');

// Address ordering used everywhere the list is returned: default address
// first (so it's always what checkout/the address book defaults to
// visually), then most-recently-added first within the rest.
const ADDRESS_ORDER_BY = [{ isDefault: 'desc' }, { createdAt: 'desc' }];

// Clears isDefault on every other address this user owns, inside the
// given transaction client. Used any time an address is (re)marked
// default, so "exactly one default per user" never has to be trusted to
// the caller — it's enforced right here, atomically, alongside the write
// that sets the new default.
const clearOtherDefaults = async (tx, userId, keepId) => {
  await tx.address.updateMany({
    where: { userId, isDefault: true, id: { not: keepId } },
    data: { isDefault: false },
  });
};

exports.createAddress = async (data) => {
  const userId = data?.user?.connect?.id;

  return prisma.$transaction(async (tx) => {
    // The very first address a user saves is always their default — there
    // is never a valid state where a user has addresses but none of them
    // is default (see prisma/schema.prisma's comment on Address.isDefault).
    const existingCount = userId ? await tx.address.count({ where: { userId } }) : 0;
    const shouldBeDefault = existingCount === 0 || data.isDefault === true;

    const address = await tx.address.create({
      data: { ...data, isDefault: shouldBeDefault },
    });

    // Only worth clearing anything if there was a prior address that could
    // have held the default flag — a brand-new user's first address has
    // nothing to clear.
    if (shouldBeDefault && userId && existingCount > 0) {
      await clearOtherDefaults(tx, userId, address.id);
    }

    return address;
  });
};

exports.getAddressesByUserId = async (userId) => {
  return prisma.address.findMany({
    where: { userId },
    orderBy: ADDRESS_ORDER_BY,
  });
};

exports.updateAddressById = async (id, userId, data) => {
  const address = await prisma.address.findFirst({
    where: { id, userId },
  });

  if (!address) {
    throw new customError('Address not found or unauthorized', 403);
  }

  // Once an address is the default, it can't be un-defaulted by editing it
  // directly (isDefault: false is silently ignored on update) — the only
  // way to change which address is default is to make a *different*
  // address the default (setDefaultAddressById, or creating/editing
  // another address with isDefault: true), which always leaves exactly
  // one default behind. This keeps "no default at all" unreachable.
  const makingDefault = data.isDefault === true;
  const { isDefault, ...rest } = data;
  const updateData = makingDefault ? { ...rest, isDefault: true } : rest;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.address.update({
      where: { id },
      data: updateData,
    });

    if (makingDefault) {
      await clearOtherDefaults(tx, userId, id);
    }

    return updated;
  });
};

exports.deleteAddressById = async (id, userId) => {
  const address = await prisma.address.findFirst({
    where: { id, userId },
  });

  if (!address) {
    throw new customError('Address not found or unauthorized', 401);
  }

  // Addresses are referenced directly by Order.addressId (a plain reference
  // on MongoDB, not an enforced FK — see prisma/schema.prisma), so nothing
  // at the DB layer stops a delete here from silently orphaning past
  // orders: order history, invoices, and shipping lookups would end up
  // reading `order.address` off a relation that no longer resolves to
  // anything. Block the delete instead of letting that happen — once an
  // address has been used on an order it's part of that order's historical
  // record and stays put; the user can still edit/re-add a fresh address
  // for future orders.
  const orderCount = await prisma.order.count({ where: { addressId: id } });
  if (orderCount > 0) {
    throw new customError(
      'This address is linked to past orders and cannot be deleted. You can add a new address instead.',
      409
    );
  }

  return prisma.$transaction(async (tx) => {
    const deleted = await tx.address.delete({ where: { id } });

    if (deleted.isDefault) {
      // The default address just went away — promote the next
      // most-recently-added remaining address so the user is never left
      // without one (matters for checkout's "default to the default
      // address" behavior, and for the address book UI).
      const next = await tx.address.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }

    return deleted;
  });
};

// Explicitly marks one address as this user's default, atomically
// clearing the flag on every other address they own. Ownership-checked
// the same way every other address mutation here is.
exports.setDefaultAddressById = async (id, userId) => {
  const address = await prisma.address.findFirst({ where: { id, userId } });

  if (!address) {
    throw new customError('Address not found or unauthorized', 403);
  }

  if (address.isDefault) return address; // already the default — no-op

  return prisma.$transaction(async (tx) => {
    const updated = await tx.address.update({ where: { id }, data: { isDefault: true } });
    await clearOtherDefaults(tx, userId, id);
    return updated;
  });
};

exports.getUserProfile = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      address: true,
      createdAt: true
    }
  });

  if (!user) {
    throw new customError('User not found', 404);
  }

  return user;
};
