import { randomUUID } from 'node:crypto';
import { JobModel } from '../models/operations.js';
import { countFailure, log } from '../middleware/telemetry.js';

export async function enqueue(type, payload, { key, session, runAt = new Date(), maxAttempts = 8, requestId } = {}) {
  if (!key) throw new Error('A stable job key is required');
  const record = { id: randomUUID(), key, type, payload, state: 'waiting', attempts: 0,
    max_attempts: maxAttempts, run_at: runAt, request_id: requestId };
  try { await JobModel.updateOne({ key }, { $setOnInsert: record }, { upsert: true, session }); }
  catch (error) { if (error.code !== 11000 || session) throw error; }
}

export class RetryAt extends Error {
  constructor(date) { super('Work is not due yet'); this.date = date; }
}

// Effects are at-least-once; handlers use business IDs and transactions for idempotency.
export async function runOneJob(handlers, { now = new Date(), leaseMs = 30000 } = {}) {
  await JobModel.updateMany({ state: 'running', lease_until: { $lte: now }, $expr: { $gte: ['$attempts', '$max_attempts'] } },
    { $set: { state: 'dead', last_error: 'worker_lease_expired' }, $unset: { lock_token: '', lease_until: '' } });
  const token = randomUUID();
  const job = await JobModel.findOneAndUpdate({ $and: [
    { $or: [{ state: 'waiting', run_at: { $lte: now } }, { state: 'running', lease_until: { $lte: now } }] },
    { $expr: { $lt: ['$attempts', '$max_attempts'] } }
  ] }, { $set: { state: 'running', lock_token: token, lease_until: new Date(now.getTime() + leaseMs) }, $inc: { attempts: 1 } },
  { sort: { run_at: 1, _id: 1 }, new: true }).lean();
  if (!job) return false;
  const fence = { id: job.id, state: 'running', lock_token: token };
  const heartbeat = setInterval(() => { JobModel.updateOne(fence, { $set: { lease_until: new Date(Date.now() + leaseMs) } }).catch(() => {}); }, Math.max(100, Math.floor(leaseMs / 3)));
  heartbeat.unref();
  try {
    if (!handlers[job.type]) throw new Error('Unknown job type');
    await handlers[job.type](job.payload, job);
    await JobModel.updateOne(fence, { $set: { state: 'completed', completed_at: new Date() }, $unset: { lock_token: '', lease_until: '', last_error: '' } });
    log('info', 'job.completed', { job_id: job.id, type: job.type, request_id: job.request_id, attempt: job.attempts });
  } catch (error) {
    const deferred = error instanceof RetryAt;
    const dead = !deferred && job.attempts >= job.max_attempts;
    if (!deferred) { countFailure('job'); log('warn', dead ? 'job.exhausted' : 'job.retry', { job_id: job.id, type: job.type, request_id: job.request_id, attempt: job.attempts }); }
    const delay = Math.min(300000, 1000 * 2 ** Math.min(job.attempts - 1, 8));
    await JobModel.updateOne(fence, { $set: { state: dead ? 'dead' : 'waiting', run_at: deferred ? error.date : new Date(Date.now() + delay),
      last_error: deferred ? 'deferred' : `handler_failed_${Number(error.code) || 'internal'}` },
      ...(deferred ? { $inc: { attempts: -1 } } : {}), $unset: { lock_token: '', lease_until: '' } });
  } finally { clearInterval(heartbeat); }
  return true;
}
