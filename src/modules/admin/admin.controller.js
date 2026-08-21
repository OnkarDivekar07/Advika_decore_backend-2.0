const adminService = require('./admin.service');
const adminAnalyticsService = require('./admin.analytics.service');
const CustomError = require('@utils/customError');

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

// GET /api/admin/users/:id
exports.getUserById = async (req, res, next) => {
  try {
    const user = await adminService.getUserDetailById(req.params.id);

    if (!user) {
      throw new CustomError('User not found', 404);
    }

    res.sendResponse({
      message: 'User fetched successfully',
      data: user,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/me
// Lets the admin panel re-confirm, on load/refresh, that the stored token
// still belongs to a real admin account — see admin.service.getCurrentAdmin
// for why this differs from the authenticate/authorizeAdminOnly checks.
exports.getCurrentAdmin = async (req, res, next) => {
  try {
    const admin = await adminService.getCurrentAdmin(req.user.userId);
    res.sendResponse({
      message: 'Current admin fetched successfully',
      data: admin,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/analytics/overview?dateFrom=&dateTo=
// PHASE 11 — date-range-scoped KPI summary. See admin.analytics.service.js
// for exactly what each field means; unfiltered, all-time figures stay on
// GET /api/admin/stats (getStats above), which this doesn't replace.
exports.getAnalyticsOverview = async (req, res, next) => {
  try {
    const overview = await adminAnalyticsService.getAnalyticsOverview({
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    });
    res.sendResponse({
      message: 'Analytics overview fetched successfully',
      data: overview,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/analytics/revenue-trend?dateFrom=&dateTo=&granularity=day|week|month
exports.getRevenueTrend = async (req, res, next) => {
  try {
    const trend = await adminAnalyticsService.getRevenueTrend({
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      granularity: req.query.granularity,
    });
    res.sendResponse({
      message: 'Revenue trend fetched successfully',
      data: trend,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/alerts?lowStockThreshold=10
// PHASE 14 — operational "needs attention" feed. Every field is a live read
// of real Order/Product/Shipment state (see admin.service.js's
// getOperationalAlerts for exactly what qualifies as each category) — there
// is nothing here for this controller to shape or filter beyond passing
// the validated threshold through.
exports.getOperationalAlerts = async (req, res, next) => {
  try {
    // admin.validation.js's validateOperationalAlertsQuery already applies
    // .toInt() and express-validator guarantees (via .isInt()) that, if
    // present, this is a numeric string — but under Express 5, req.query
    // is a getter with no setter, so express-validator's sanitizers can
    // mutate the object express-validator reads internally without that
    // mutation surviving on req.query itself. Re-coercing here (rather
    // than trusting req.query.lowStockThreshold to already be a Number)
    // means this doesn't silently regress into passing a string down to
    // Prisma's `stock: { lte: threshold }` in
    // inventoryService.listLowStockProducts — MongoDB Prisma throws on a
    // type-mismatched filter value, so an un-coerced string here isn't
    // just a style nit, it's a 500 waiting to happen.
    const { lowStockThreshold } = req.query;
    const alerts = await adminService.getOperationalAlerts({
      lowStockThreshold:
        lowStockThreshold === undefined ? undefined : Number(lowStockThreshold),
    });
    res.sendResponse({
      message: 'Operational alerts fetched successfully',
      data: alerts,
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
