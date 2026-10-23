import { ZodError } from 'zod';
import mongoose from 'mongoose';
export class ApiError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export const fail = (code, message) => { throw new ApiError(code, message); };
export const asyncRoute = (fn) => (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); };
export const parse = (schema, value) => schema.parse(value);
export function handleError(err, _req, res, _next) {
    if (err instanceof ApiError) {
        res.status(err.code).json({ error: err.message });
        return;
    }
    if (err instanceof ZodError) {
        res.status(422).json({ error: 'Invalid request data', details: err.issues.map(x => ({ field: x.path.join('.'), message: x.message })) });
        return;
    }
    if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
        res.status(422).json({ error: 'Invalid database payload' });
        return;
    }
    if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
        res.status(409).json({ error: 'Duplicate request' });
        return;
    }
    console.error('[internal]', err instanceof Error ? err.message : 'unexpected failure');
    res.status(503).json({ error: 'Service temporarily unavailable. Retry later.' });
}
