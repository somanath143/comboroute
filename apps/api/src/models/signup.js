import { Schema, model } from 'mongoose';

// Pending registration is not an account. Sensitive values are never selected by default.
const pendingSignup = new Schema({
  email: { type: String, required: true, unique: true },
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password_hash: { type: String, select: false },
  otp_hash: { type: String, select: false },
  delivery_id: String,
  status: { type: String, enum: ['sending', 'sent', 'delivery_failed', 'consumed'], required: true },
  expires_at: Date,
  resend_after: Date,
  attempts: { type: Number, default: 0 },
  total_attempts: { type: Number, default: 0 },
  send_count: { type: Number, default: 0 },
  window_started_at: { type: Date, required: true },
  purge_at: { type: Date, required: true }
}, { timestamps: true, versionKey: false });
pendingSignup.index({ purge_at: 1 }, { expireAfterSeconds: 0 });
export const PendingSignupModel = model('PendingSignup', pendingSignup);
