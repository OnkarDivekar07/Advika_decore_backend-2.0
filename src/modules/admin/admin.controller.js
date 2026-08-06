const adminService = require('./admin.service');

// GET /api/admin/stats
exports.getStats = async (req, res, next) => {
  try {
    const stats = await adminService.getAdminStats();
    res.sendResponse({
      message: 'Stats fetched successfully',
      data: stats,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/users?page=1&limit=10&sort=createdAt&order=desc&role=user
exports.getAllUsersWithStats = async (req, res, next) => {
  try {
    const result = await adminService.getAllUsersWithStats(req);
    res.sendResponse({
      message: 'Users fetched successfully',
      data: result.data,
      meta: result.meta,
    });
  } catch (err) {
    next(err);
  }
};

exports.loginAdmin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await adminService.login({ email, password });

    res.sendResponse({
      message: 'Admin logged in successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
