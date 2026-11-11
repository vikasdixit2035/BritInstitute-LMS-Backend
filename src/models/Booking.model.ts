import mongoose, { Document, Schema } from 'mongoose';
import type { SessionEmailPayload } from '../services/resend.service';

export interface BookingEmail {
  _id: mongoose.Types.ObjectId;
  kind: 'confirmation' | 'reminder';
  audience: 'learner' | 'office';
  sessionAt: Date;
  nextAttemptAt: Date;
  state: 'pending' | 'sent' | 'skipped' | 'failed';
  attempts: number;
  lockedUntil: Date;
  lockToken?: string;
  payload?: SessionEmailPayload;
  firstAttemptAt?: Date;
  sentAt?: Date;
  providerId?: string;
  lastError?: string;
}

const bookingEmailSchema = new Schema<BookingEmail>({
  kind: { type: String, enum: ['confirmation', 'reminder'], required: true },
  audience: { type: String, enum: ['learner', 'office'], required: true },
  sessionAt: { type: Date, required: true },
  nextAttemptAt: { type: Date, required: true },
  state: { type: String, enum: ['pending', 'sent', 'skipped', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: () => new Date(0) },
  lockToken: String,
  payload: Schema.Types.Mixed,
  firstAttemptAt: Date,
  sentAt: Date,
  providerId: String,
  lastError: String,
});

export interface IBooking extends Document {
  student: mongoose.Types.ObjectId;
  mentor: mongoose.Types.ObjectId;
  topic: string;
  dateTime: Date;
  duration: number; // in minutes
  status: 'pending' | 'accepted' | 'completed' | 'cancelled';
  meetingLink?: string;
  zoomMeetingId?: string;
  zoomStartUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  emailNotifications?: BookingEmail[];
}

const bookingSchema = new Schema<IBooking>(
  {
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mentor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    topic: { type: String, required: true, trim: true },
    dateTime: { type: Date, required: true },
    duration: { type: Number, default: 30 },
    status: { 
      type: String, 
      enum: ['pending', 'accepted', 'completed', 'cancelled'], 
      default: 'pending' 
    },
    meetingLink: { type: String },
    zoomMeetingId: { type: String, trim: true },
    zoomStartUrl: { type: String },
    // Stored with the booking atomically; omitted from API responses by default.
    emailNotifications: { type: [bookingEmailSchema], default: undefined, select: false },
  },
  { timestamps: true }
);

bookingSchema.index({ mentor: 1, dateTime: 1, status: 1 });
bookingSchema.index({ student: 1, dateTime: 1 });
bookingSchema.index({ 'emailNotifications.state': 1, 'emailNotifications.nextAttemptAt': 1 });

export const Booking = mongoose.model<IBooking>('Booking', bookingSchema);
