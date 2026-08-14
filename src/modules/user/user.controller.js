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

// @desc    Mark a delivery address as the default for the logged-in user
// @route   PATCH /api/user/address/:id/default
// @access  User
exports.setDefaultAddress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const address = await userService.setDefaultAddressById(id, userId);

    res.sendResponse({
      message: 'Default address updated successfully',
      data: address,
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

// @desc    Update the logged-in user's profile (display name)
// @route   PATCH /api/user/profile
// @access  User
exports.updateProfile = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const profile = await userService.updateUserProfile(userId, req.body);

    res.sendResponse({
      message: 'Profile updated successfully',
      data: profile,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Send an OTP to a new mobile number, as the first step of
//          changing the logged-in user's phone
// @route   POST /api/user/phone/send-otp
// @access  User
exports.sendPhoneChangeOtp = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { phone } = req.body;
    await userService.sendPhoneChangeOtp(userId, phone);

    res.sendResponse({
      message: 'OTP sent successfully',
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Verify the OTP sent to the new mobile number and update the
//          logged-in user's phone
// @route   POST /api/user/phone/verify-otp
// @access  User
exports.verifyPhoneChangeOtp = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { phone, otp } = req.body;
    const profile = await userService.confirmPhoneChange(userId, phone, otp);

    res.sendResponse({
      message: 'Mobile number updated successfully',
      data: profile,
    });
  } catch (err) {
    next(err);
  }
};
