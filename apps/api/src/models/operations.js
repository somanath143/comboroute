import { Schema, model } from 'mongoose';
const options = { timestamps: true, versionKey: false };
export const ReservationModel = model('Reservation', new Schema({
  id: { type: String, required: true, unique: true },
  customer_id: { type: Number, required: true },
  status: { type: String, enum: ['reserved', 'committed', 'released'], default: 'reserved' },
  expires_at: { type: Date, required: true },
  items: [{ _id: false, menu_item_id: Number, quantity: Number }],
  snapshot: { type: Schema.Types.Mixed, required: true },
  order_id: String, released_reason: String
}, options));
ReservationModel.schema.index({ status: 1, expires_at: 1 });
export const JobModel = model('BackgroundJob', new Schema({
  id: { type: String, required: true, unique: true },
  key: { type: String, required: true, unique: true },
  type: { type: String, required: true }, payload: Schema.Types.Mixed,
  state: { type: String, enum: ['waiting', 'running', 'completed', 'dead'], default: 'waiting' },
  attempts: { type: Number, default: 0 }, max_attempts: { type: Number, default: 8 },
  run_at: { type: Date, required: true }, lease_until: Date, lock_token: String,
  last_error: String, completed_at: Date, request_id: String
}, options));
JobModel.schema.index({ state: 1, run_at: 1 });
JobModel.schema.index({ state: 1, lease_until: 1 });
JobModel.schema.index({ createdAt: -1, id: -1 });
export const AuditModel = model('AuditEvent', new Schema({
  id: { type: String, required: true, unique: true },
  actor_id: String, actor_role: String, action: { type: String, required: true },
  resource_id: String, request_id: String, details: Schema.Types.Mixed
}, { ...options, immutable: true }));
AuditModel.schema.index({ createdAt: -1, id: -1 });
export const NotificationModel = model('Notification', new Schema({
  key: { type: String, required: true, unique: true }, customer_id: { type: Number, required: true },
  order_id: String, message: String, read_at: Date
}, options));
NotificationModel.schema.index({ customer_id: 1, createdAt: -1, _id: -1 });
export const PartnerModel = model('PartnerProfile', new Schema({
  user_id: { type: String, required: true, unique: true },
  available: { type: Boolean, default: true }, capacity: { type: Number, default: 1, min: 1, max: 5 },
  active_count: { type: Number, default: 0, min: 0 }
}, options));
export const AssignmentModel = model('DeliveryAssignment', new Schema({
  order_id: { type: String, required: true, unique: true },
  partner_id: String, token: String,
  status: { type: String, enum: ['active', 'picked_up', 'completed', 'expired'], required: true },
  expires_at: Date
}, options));
AssignmentModel.schema.index({ status: 1, expires_at: 1 });
export const CatalogVersionModel = model('CatalogVersion', new Schema({ _id: String, version: { type: Number, default: 0 } }, options));
export const WorkerModel = model('WorkerHeartbeat', new Schema({ id: { type: String, unique: true }, last_seen: Date, pid: Number }, options));
WorkerModel.schema.index({ last_seen: 1 }, { expireAfterSeconds: 86400 });
export const ScanCursorModel = model('MaintenanceScanCursor', new Schema({ _id: String, last_id: Schema.Types.ObjectId }, options));
