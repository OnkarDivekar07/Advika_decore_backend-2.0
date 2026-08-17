// src/utils/invalidateCacheByPrefix.js
const redis = require('@config/redis');

// paginateWithCache (see paginateWithCache.js) writes each page/filter/
// sort combination under its own key: `${cachePrefix}:${JSON.stringify(...)}`.
// That means there is no single key to delete after a mutation (create,
// update, delete) — only a prefix's worth of keys, one per query-param
// combination anyone has hit since the last invalidation. This walks the
// keyspace with SCAN (never KEYS, which blocks the single-threaded Redis
// event loop for as long as the scan takes on a large keyspace) and
// deletes every match.
//
// Callers should invoke this any time the underlying data a cachePrefix
// covers changes — e.g. after a product create/update/delete, since
// GET /api/products (cachePrefix 'allProducts') and
// GET /api/homepage/new-arrivals (cachePrefix 'newArrivalProducts') would
// otherwise keep serving stale results for up to cacheExpiry seconds.
const invalidateCacheByPrefix = async (prefix) => {
  const pattern = `${prefix}:*`;
  let cursor = '0';

  do {
    // eslint-disable-next-line no-await-in-loop
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await redis.del(...keys);
    }
  } while (cursor !== '0');
};

module.exports = invalidateCacheByPrefix;
