import mongoose from 'mongoose';
import { ApiError } from '../middleware/errors.js';

export async function pageQuery(Model, match, query = {}, { select, idField = 'id', serialize = row => row } = {}) {
  const paged = query.limit !== undefined || query.after !== undefined;
  const limit = paged ? Number(query.limit ?? 25) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(422, 'limit must be between 1 and 100');
  const filters = [match];
  if (query.after) {
    try {
      if (typeof query.after !== 'string' || query.after.length > 512) throw new Error();
      const cursor = JSON.parse(Buffer.from(query.after, 'base64url').toString());
      const date = new Date(cursor.at);
      if (!Number.isFinite(date.getTime()) || typeof cursor.id !== 'string' || cursor.id.length > 120 || idField === '_id' && !mongoose.isValidObjectId(cursor.id)) throw new Error();
      filters.push({ $or: [{ createdAt: { $lt: date } }, { createdAt: date, [idField]: { $lt: cursor.id } }] });
    } catch { throw new ApiError(422, 'Invalid pagination cursor'); }
  }
  let request = Model.find({ $and: filters }).sort({ createdAt: -1, [idField]: -1 }).limit(limit + 1);
  if (select) request = request.select(select);
  const rows = await request.lean();
  const more = rows.length > limit; const slice = rows.slice(0, limit); const last = slice.at(-1);
  const items = await serialize(slice);
  if (!paged) return items;
  return { items, next_cursor: more && last ? Buffer.from(JSON.stringify({ at: last.createdAt, id: String(last[idField]) })).toString('base64url') : null };
}
