import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { Booking, BookingEmail, IBooking } from '../models/Booking.model';
import { User } from '../models/User.model';
import { SessionEmailQuota } from '../models/SessionEmailQuota.model';
import { config } from '../config/env';
import { ResendEmailError, sendSessionEmail, SESSION_EMAIL_ADDRESS, SessionEmailPayload } from './resend.service';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ['pending', 'accepted'];

export const createBookingEmails = (sessionAt: Date, now = new Date(), remindersOnly = false): BookingEmail[] =>
  (remindersOnly ? ['reminder'] as const : ['confirmation', 'reminder'] as const).flatMap(kind =>
    (['learner', 'office'] as const).map(audience => ({
      _id: new Types.ObjectId(), kind, audience, sessionAt,
      nextAttemptAt: kind === 'confirmation' ? now : new Date(Math.max(now.getTime(), sessionAt.getTime() - TWO_HOURS)),
      state: 'pending' as const, attempts: 0, lockedUntil: new Date(0),
    })));

// Called before save, so the schedule and its reminders change together.
export const resetBookingReminders = (booking: IBooking): void => {
  // Existing bookings receive no retroactive confirmation emails.
  const reminders = createBookingEmails(booking.dateTime, new Date(), true);
  if (!booking.emailNotifications?.length) {
    booking.emailNotifications = reminders;
    return;
  }
  // Change reminder paths only. A concurrent confirmation worker may have
  // updated its delivery state since this controller loaded the booking.
  let reminderIndex = 0;
  booking.emailNotifications.forEach((email, index) => {
    if (email.kind === 'reminder') booking.set(`emailNotifications.${index}`, reminders[reminderIndex++]);
  });
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const buildPayload = async (booking: IBooking, email: BookingEmail): Promise<SessionEmailPayload | null> => {
  const [student, mentor] = await Promise.all([
    User.findById(booking.student).select('name email'),
    User.findById(booking.mentor).select('name'),
  ]);
  const learnerEmail = student?.email?.trim();
  if (email.audience === 'learner' && (!learnerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(learnerEmail))) return null;
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', dateStyle: 'full', timeStyle: 'short',
  }).format(booking.dateTime);
  const subject = email.kind === 'confirmation' ? '1:1 mentor session booking received' : 'Reminder: upcoming 1:1 mentor session';
  const introduction = email.kind === 'confirmation'
    ? 'Your 1:1 session booking request has been received.'
    : 'Your 1:1 session is coming up. Please review the session details below.';
  // Only the participant link may be included; never include Zoom's host URL.
  const joinUrl = booking.status === 'accepted' && /^https?:\/\//i.test(booking.meetingLink || '') ? booking.meetingLink : undefined;
  const lines = [
    email.audience === 'learner' ? `Hello ${student?.name || 'learner'},` : 'Hello Brit Institute team,',
    email.audience === 'learner' ? introduction : (email.kind === 'confirmation' ? 'A learner has booked a 1:1 mentor session.' : 'A learner has an upcoming 1:1 mentor session.'),
    `Learner: ${student?.name || 'Learner'}`,
    ...(email.audience === 'office' ? [`Learner email: ${learnerEmail || 'Not provided in learner profile'}`] : []),
    `Mentor: ${mentor?.name || 'Assigned mentor'}`,
    `Topic: ${booking.topic}`,
    `When: ${when} (Europe/London, UK time)`,
    `Duration: ${booking.duration} minutes`,
    `Status: ${booking.status === 'pending' ? 'Awaiting mentor approval' : 'Accepted'}`,
    `Booking reference: ${booking._id}`,
    joinUrl ? `Join session: ${joinUrl}` : 'The meeting link will be available in your LMS after mentor approval.',
    'Please check your LMS for the latest session details.',
    'Brit Institute',
  ];
  return {
    from: `Brit Institute <${SESSION_EMAIL_ADDRESS}>`,
    to: [email.audience === 'learner' ? learnerEmail! : SESSION_EMAIL_ADDRESS],
    reply_to: SESSION_EMAIL_ADDRESS,
    subject: `Brit Institute | ${subject}`,
    text: lines.join('\n\n'),
    html: lines.map(line => `<p>${escapeHtml(line)}</p>`).join('\n'),
  };
};

const nextUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

const reserveDailySlot = async (key: string, now: Date): Promise<boolean> => {
  const day = now.toISOString().slice(0, 10);
  try {
    await SessionEmailQuota.updateOne({ _id: day }, {
      $setOnInsert: { keys: [], expiresAt: new Date(nextUtcDay(now).getTime() + 2 * 24 * 60 * 60 * 1000) },
    }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  return !!await SessionEmailQuota.findOneAndUpdate({
    _id: day,
    $or: [{ keys: key }, { 'keys.99': { $exists: false } }],
  }, { $addToSet: { keys: key } });
};

export const processBookingEmails = async (bookingId: string, now = new Date()): Promise<void> => {
  if (!config.resendApiKey) return;
  const booking = await Booking.findById(bookingId).select('+emailNotifications');
  if (!booking || !ACTIVE_STATUSES.includes(booking.status) || booking.dateTime <= now) return;
  for (const candidate of booking.emailNotifications || []) {
    if (candidate.state !== 'pending' || candidate.nextAttemptAt > now || candidate.lockedUntil > now) continue;
    const token = randomUUID();
    const claimed = await Booking.findOneAndUpdate({
      _id: bookingId, status: { $in: ACTIVE_STATUSES }, dateTime: { $gt: now },
      emailNotifications: { $elemMatch: {
        _id: candidate._id, state: 'pending', nextAttemptAt: { $lte: now }, lockedUntil: { $lte: now },
      } },
    }, {
      $set: { 'emailNotifications.$.lockToken': token, 'emailNotifications.$.lockedUntil': new Date(now.getTime() + 60_000) },
      $inc: { 'emailNotifications.$.attempts': 1 },
    }, { new: true }).select('+emailNotifications');
    const email = claimed?.emailNotifications?.find(item => item._id.equals(candidate._id));
    if (!claimed || !email) continue;
    const filter = { _id: bookingId, emailNotifications: { $elemMatch: { _id: email._id, lockToken: token } } };
    const update = (fields: Record<string, unknown>) => Booking.updateOne(filter, { $set: Object.fromEntries(
      Object.entries({ lockedUntil: new Date(0), ...fields }).map(([key, value]) => [`emailNotifications.$.${key}`, value])
    ) });
    try {
      if (email.kind === 'reminder' && email.sessionAt.getTime() !== claimed.dateTime.getTime()) {
        await update({ state: 'skipped', lastError: 'Session schedule changed' });
        continue;
      }
      // Resend only retains idempotency keys for 24 hours. Stop ambiguous retries
      // before that expires, rather than risk delivering a duplicate email.
      if (email.firstAttemptAt && now.getTime() - email.firstAttemptAt.getTime() >= 23 * 60 * 60 * 1000) {
        await update({ state: 'failed', lastError: 'Retry window expired; check Resend delivery history before retrying manually' });
        console.error(`Session email ${email._id}: retry window expired`);
        continue;
      }
      const payload = email.payload || await buildPayload(claimed, email);
      if (!payload) {
        await update({ nextAttemptAt: new Date(now.getTime() + 15 * 60_000), lastError: 'Learner profile needs a valid email address' });
        console.warn(`Session email ${email._id}: learner profile needs a valid email address`);
        continue;
      }
      const key = `session/${bookingId}/${email._id}`;
      if (!await reserveDailySlot(key, now)) {
        await update({ nextAttemptAt: nextUtcDay(now), lastError: '100-email daily safety limit reached' });
        console.warn('Session emails: 100-email daily safety limit reached');
        continue;
      }
      // Freeze the complete payload before the HTTP call. Retries must use the
      // same body as well as the same idempotency key, even if a profile changes.
      await Booking.updateOne(filter, { $set: {
        'emailNotifications.$.payload': payload,
        'emailNotifications.$.firstAttemptAt': email.firstAttemptAt || now,
      } });
      // Check cancellation/rescheduling again immediately before the side effect.
      const stillActive = await Booking.exists({
        ...filter, status: { $in: ACTIVE_STATUSES }, dateTime: { $gt: now },
      });
      if (!stillActive) continue;
      const providerId = await sendSessionEmail(payload, key);
      await update({ state: 'sent', providerId, sentAt: now, lastError: '' });
    } catch (error) {
      const delay = error instanceof ResendEmailError && /quota/.test(error.code)
        ? nextUtcDay(now).getTime() - now.getTime()
        : Math.max(Math.min(60_000 * 2 ** Math.min(email.attempts - 1, 4), 15 * 60_000),
          error instanceof ResendEmailError ? error.retryAfterSeconds * 1000 : 0);
      const message = error instanceof ResendEmailError ? error.message : 'Email delivery failed; retry queued';
      await update({ nextAttemptAt: new Date(now.getTime() + delay), lastError: message });
      console.error(`Session email ${email._id}: ${message}`);
    }
  }
};

export const processDueBookingEmails = async (now = new Date()): Promise<void> => {
  if (!config.resendApiKey) return;
  await Booking.updateMany({
    $or: [{ status: { $nin: ACTIVE_STATUSES } }, { dateTime: { $lte: now } }],
    'emailNotifications.state': 'pending',
  }, { $set: { 'emailNotifications.$[email].state': 'skipped' } }, { arrayFilters: [{ 'email.state': 'pending' }] });
  const due = await Booking.find({
    status: { $in: ACTIVE_STATUSES }, dateTime: { $gt: now },
    emailNotifications: { $elemMatch: { state: 'pending', nextAttemptAt: { $lte: now }, lockedUntil: { $lte: now } } },
  }).select('_id').sort({ 'emailNotifications.nextAttemptAt': 1 }).limit(100);
  for (const booking of due) await processBookingEmails(String(booking._id), now);
};

// Booking success must never depend on the availability of the email provider.
export const dispatchBookingEmails = (bookingId: string): void => {
  void processBookingEmails(bookingId).catch(() => console.error(`Session email worker failed for booking ${bookingId}; retry queued`));
};
