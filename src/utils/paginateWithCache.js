const redis = require('@config/redis');

const paginateWithCache = async ({
  model,
  req,
  where = {},
  select,
  include,
  orderBy = { createdAt: 'desc' },
  cachePrefix = '',
  cacheExpiry = 300, // seconds
  cache = true, // NEW flag to enable/disable caching
  searchableFields = [], // e.g., ['name', 'description']
  filterableFields = [], // e.g., ['category', 'brand']
}) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const sort = req.query.sort || Object.keys(orderBy)[0];
  const order = req.query.order || orderBy[sort] || 'desc';
  const searchQuery = req.query.search || '';

  const filters = {};
  filterableFields.forEach((field) => {
    if (req.query[field] !== undefined) {
      filters[field] = req.query[field];
    }
  });

  const searchConditions =
    searchQuery && searchableFields.length > 0
      ? {
          OR: searchableFields.map((field) => ({
            [field]: { contains: searchQuery, mode: 'insensitive' },
          })),
        }
      : {};

  const finalWhere = {
    AND: [where, filters, searchConditions].filter(
      (obj) => Object.keys(obj).length > 0
    ),
  };

  // Stable cache key: consistent key order
  const cacheKey = `${cachePrefix}:${JSON.stringify({
    page,
    limit,
    sort,
    order,
    filters: Object.keys(filters)
      .sort()
      .reduce((acc, key) => {
        acc[key] = filters[key];
        return acc;
      }, {}),
    searchQuery,
  })}`;

  if (cache) {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) return JSON.parse(cachedData);
  }

  const skip = (page - 1) * limit;

  const [total, data] = await Promise.all([
    model.count({ where: finalWhere }),
    model.findMany({
      where: finalWhere,
      select,
      include,
      orderBy: { [sort]: order },
      skip,
      take: limit,
    }),
  ]);

  const result = {
    data,
    meta: {
      timestamp: new Date(),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };

  if (cache) {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', cacheExpiry);
  }

  return result;
};

module.exports = paginateWithCache;
