import mongoose, { Schema } from 'mongoose';

// Shared across server processes. Reserve a slot before contacting Resend.
// A retry of the same notification does not consume another daily slot.
const schema = new Schema({
  _id: { type: String, required: true },
  keys: { type: [String], default: [] },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionEmailQuota = mongoose.model('SessionEmailQuota', schema);
