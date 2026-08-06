const userService = require('./user.service');

// @desc    Create a new delivery address
// @route   POST /api/user/address
// @access  User
exports.createAddress = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const data = {
      ...req.body,
      user: {
        connect: { id: userId },
      },
    };

    const address = await userService.createAddress(data);

    res.sendResponse({
      message: 'Address created successfully',
      data: address,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get all delivery addresses for a user
// @route   GET /api/user/addresses
// @access  User
exports.getAddresses = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const addresses = await userService.getAddressesByUserId(userId);

    res.sendResponse({
      message: 'Addresses fetched successfully',
      data: addresses,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Update a delivery address by ID
// @route   PUT /api/user/address/:id
// @access  User
exports.updateAddress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const updatedAddress = await userService.updateAddressById(
      id,
      userId,
      req.body
    );

    res.sendResponse({
      message: 'Address updated successfully',
      data: updatedAddress,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete a delivery address by ID
// @route   DELETE /api/user/address/:id
// @access  User
exports.deleteAddress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    await userService.deleteAddressById(id, userId);

    res.sendResponse({
      message: 'Address deleted successfully',
    });
  } catch (err) {
    next(err);
  }
};




exports.getUserProfile = async (req, res, next) => {
  try {
    const userId = req.user.userId; // Assuming JWT middleware attaches user
    const profile = await userService.getUserProfile(userId);

    res.sendResponse({
      message: 'User profile fetched successfully',
      data: profile,
    });
  } catch (err) {
    next(err);
  }
};
