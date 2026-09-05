const redis = require('@config/redis');
const withTimeout = require('@utils/withTimeout');
const logger = require('@config/logger');

// Pattern 18 (error handling/resilience audit): same root cause as
// rateLimiter.js's REDIS_CHECK_TIMEOUT_MS — @config/redis.js's shared
// client queues commands forever while Redis is unreachable rather than
// rejecting. Confirmed live: a genuinely down Redis made every cached
// listing endpoint (products, admin users, banners, new arrivals — every
// caller of this function) hang indefinitely instead of just serving the
// real, correct data straight from the database. Unlike the rate
// limiter, caching is a pure optimization with no safety property to fail
// closed over — skipping it and querying live is strictly the right
// degradation, not a masked infrastructure error, since the response
// returned is still genuinely correct.
const REDIS_CACHE_TIMEOUT_MS = 1500;

// A caller-supplied `limit` was previously passed straight to Prisma's
// `take` with no upper bound — `?limit=100000` on any paginated admin/
// public list endpoint would run a single unbounded query. This is the
// one place every one of those endpoints funnels through, so capping it
// here protects all of them (products, admin users, banners, new
// arrivals, …) without needing the same clamp re-added in each caller.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

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
  // Extra values to fold into the cache key when a caller builds part of
  // `where` itself (e.g. a price range or an array-contains category
  // filter) instead of going through `filterableFields`. Without this,
  // two requests that differ only in that custom filtering — but agree on
  // page/limit/sort/search — would collide on the same cache key and
  // silently serve each other's results.
  cacheKeyExtra = {},
  formatter, // optional (item) => transformedItem
}) => {
  const requestedPage = parseInt(req.query.page, 10);
  const page =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const requestedLimit = parseInt(req.query.limit, 10);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

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
    ...cacheKeyExtra,
  })}`;

  if (cache) {
    try {
      const cachedData = await withTimeout(
        redis.get(cacheKey),
        REDIS_CACHE_TIMEOUT_MS,
        `cache read (${cachePrefix})`
      );
      if (cachedData) return JSON.parse(cachedData);
    } catch (err) {
      logger.warn(
        `Cache read failed for ${cacheKey}, falling back to a live query: ${err.message}`
      );
    }
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

  const formattedData = formatter ? data.map(formatter) : data;

  const result = {
    data: formattedData,
    meta: {
      timestamp: new Date(),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };

  if (cache) {
    // Deliberately not awaited: `result` is already correct and ready to
    // return regardless of whether the cache write succeeds — making the
    // caller wait on a write-behind cache populate (and, worse, wait out
    // REDIS_CACHE_TIMEOUT_MS if Redis is down) would only add latency to
    // an otherwise-successful response for zero benefit. Still bounded and
    // caught so a slow/broken Redis can't leave an unhandled rejection.
    withTimeout(
      redis.set(cacheKey, JSON.stringify(result), 'EX', cacheExpiry),
      REDIS_CACHE_TIMEOUT_MS,
      `cache write (${cachePrefix})`
    ).catch((err) => {
      logger.warn(`Cache write failed for ${cacheKey}: ${err.message}`);
    });
  }

  return result;
};

module.exports = paginateWithCache;
