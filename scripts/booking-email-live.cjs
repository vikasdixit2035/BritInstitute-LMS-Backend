'use strict';
// Explicitly invoked only: sends four REAL test emails using a disposable DB.
if (!process.argv.includes('--send-live-test-emails')) {
  console.error('This sends four real test emails. Run npm run test:booking-emails:live -- --send-live-test-emails');
  process.exit(1);
}
const assert = require('node:assert/strict');
const { startHarness, waitFor, config, Booking } = require('./booking-email-harness.cjs');
const { processDueBookingEmails } = require('../dist/services/bookingEmail.service');

async function run() {
  if (!config.resendApiKey) throw new Error('Set RESEND_API_KEY in .env');
  const h = await startHarness();
  try {
    const response = await h.create(4, { topic: '[AUTOMATED EMAIL TEST - NO REAL APPOINTMENT] 1:1 booking and reminder verification' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.booking._id;
    await waitFor(async () => {
      const booking = await Booking.findById(id).select('+emailNotifications');
      return booking.emailNotifications.filter(email => email.kind === 'confirmation' && email.state === 'sent').length === 2;
    }, 'two live confirmation emails accepted by Resend');
    let booking = await Booking.findById(id).select('+emailNotifications');
    console.log('Two confirmation emails accepted by Resend.');
    // Advance only the worker's clock: no system clock or real LMS data changes.
    const reminderTime = new Date(booking.dateTime.getTime() - 2 * 60 * 60_000);
    await processDueBookingEmails(reminderTime);
    booking = await Booking.findById(id).select('+emailNotifications');
    assert.equal(booking.emailNotifications.filter(email => email.state === 'sent').length, 4,
      JSON.stringify(booking.emailNotifications.map(e => ({ kind: e.kind, audience: e.audience, state: e.state, lastError: e.lastError }))));
    for (const email of booking.emailNotifications) {
      console.log(JSON.stringify({ kind: email.kind, audience: email.audience, recipient: email.payload.to[0], providerId: email.providerId, state: email.state }));
    }
    // Observe provider delivery events without reading or outputting email bodies.
    const ids = booking.emailNotifications.map(email => email.providerId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const statuses = [];
      for (const providerId of ids) {
        const response = await fetch(`https://api.resend.com/emails/${providerId}`, {
          headers: { Authorization: `Bearer ${config.resendApiKey}` }, signal: AbortSignal.timeout(10_000),
        });
        const data = await response.json();
        statuses.push({ providerId, status: response.status, event: data.last_event || data.name || 'unknown' });
        await new Promise(resolve => setTimeout(resolve, 650));
      }
      console.log(JSON.stringify({ deliveryEvents: statuses }));
      if (statuses.every(item => item.event === 'delivered')) return;
      if (statuses.some(item => item.status === 403)) return; // Sending-only keys cannot read events.
      if (statuses.some(item => ['bounced', 'failed', 'suppressed'].includes(item.event))) throw new Error('A live test email was not delivered; inspect the Resend dashboard');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    console.log('All four accepted; delivery events still pending. Check the Resend dashboard for final delivery.');
  } finally {
    await h.close();
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
