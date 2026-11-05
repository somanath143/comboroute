import { RestaurantModel, MenuModel } from '../models/index.js';
import { CatalogVersionModel } from '../models/operations.js';
import { ApiError } from '../middleware/errors.js';
const cache = new Map();
export const catalogCacheStats = { hits: 0, misses: 0 };
export async function invalidateCatalog(session) {
  await CatalogVersionModel.updateOne({ _id: 'catalog' }, { $inc: { version: 1 } }, { upsert: true, session });
  cache.clear();
}
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function searchRestaurants(query = {}) {
  const q = String(query.q ?? '').trim().slice(0, 120), cuisine = String(query.cuisine ?? 'All');
  const sort = String(query.sort ?? 'recommended');
  const limit = Number(query.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(422, 'limit must be between 1 and 100');
  const version = (await CatalogVersionModel.findById('catalog').lean())?.version ?? 0;
  const key = JSON.stringify({ q, cuisine, sort, veg: query.veg_only === 'true', limit, version });
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) { catalogCacheStats.hits++; return { items: cached.items, hit: true }; }
  catalogCacheStats.misses++;
  const conditions = [];
  if (q) {
    const regex = { $regex: escapeRegex(q), $options: 'i' };
    const menuMatches = await MenuModel.distinct('restaurant_id', { $or: ['name', 'description', 'category'].map(field => ({ [field]: regex })) });
    conditions.push({ $or: [...['name', 'cuisine', 'description'].map(field => ({ [field]: regex })), { id: { $in: menuMatches } }] });
  }
  if (cuisine !== 'All') conditions.push({ category: { $regex: '^' + escapeRegex(cuisine) + '$', $options: 'i' } });
  const nonVeg = await MenuModel.distinct('restaurant_id', { is_veg: { $ne: true } });
  if (query.veg_only === 'true') conditions.push({ id: { $nin: nonVeg } });
  const ordering = sort === 'rating' ? { rating: -1, id: 1 } : sort === 'time' ? { prep_minutes: 1, id: 1 } : { is_open: -1, rating: -1, ratings_count: -1, id: 1 };
  const rows = await RestaurantModel.find(conditions.length ? { $and: conditions } : {}).sort(ordering).limit(limit).select('-_id -__v').lean();
  const items = rows.map(r => ({ ...r, pure_veg: !nonVeg.includes(r.id) }));
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(key, { items, expires: Date.now() + 15000 });
  return { items, hit: false };
}
