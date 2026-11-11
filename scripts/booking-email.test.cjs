'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
process.env.RESEND_API_KEY = 'test-key-no-real-email';
process.env.JWT_SECRET = 'isolated-booking-test-secret';
const { startHarness, waitFor, config, User, Booking, SessionEmailQuota } = require('./booking-email-harness.cjs');
const { resetBookingReminders, processBookingEmails, processDueBookingEmails } = require('../dist/services/bookingEmail.service');

test('1:1 booking email lifecycle over HTTP with isolated MongoDB', async t => {
  const requests = [];
  const delivered = new Map();
  let mode = 'ok';
  let failLearnerOnce = false;
  const nativeFetch = global.fetch;
  // A real HTTP fixture exercises serialization, auth, error responses and retry
  // behavior. Its contract follows Resend's official /emails documentation.
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const key = req.headers['idempotency-key'];
    requests.push({ body, key, auth: req.headers.authorization, path: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'outage') return res.writeHead(503).end('<html>Service unavailable</html>');
    if (mode === 'quota') return res.writeHead(429).end(JSON.stringify({ name: 'daily_quota_exceeded' }));
    if (failLearnerOnce && body.to[0] === 'hhimanshu030@gmail.com') {
      failLearnerOnce = false;
      return res.writeHead(429, { 'Retry-After': '120' }).end(JSON.stringify({ name: 'rate_limit_exceeded' }));
    }
    const previous = delivered.get(key);
    if (previous && previous.raw !== raw) return res.writeHead(409).end(JSON.stringify({ name: 'invalid_idempotent_request' }));
    const id = previous?.id || `fixture-email-${delivered.size + 1}`;
    delivered.set(key, { id, raw });
    if (mode === 'ambiguous') return req.socket.destroy();
    res.end(JSON.stringify({ id }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}/emails`;
  global.fetch = (url, options) => nativeFetch(String(url) === 'https://api.resend.com/emails' ? endpoint : url, options);
  let h;
  t.after(async () => {
    global.fetch = nativeFetch;
    if (h) await h.close();
    await new Promise(resolve => provider.close(resolve));
  });
  h = await startHarness();
  const getBooking = id => Booking.findById(id).select('+emailNotifications');
  const reset = async () => {
    config.resendApiKey = '';
    await Booking.deleteMany({});
    await SessionEmailQuota.deleteMany({});
    requests.length = 0;
    delivered.clear();
    mode = 'ok';
    failLearnerOnce = false;
  };
  const quietBooking = async (hours = 4, extra = {}, user) => {
    config.resendApiKey = '';
    const response = await h.create(hours, extra, user);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    config.resendApiKey = 'test-key-no-real-email';
    return getBooking(response.body.booking._id);
  };

  await t.test('immediately sends two confirmations; API responses hide private email state', async () => {
    await reset();
    config.resendApiKey = 'test-key-no-real-email';
    const response = await h.create();
    assert.equal(response.status, 201);
    assert.equal(response.body.booking.emailNotifications, undefined);
    const id = response.body.booking._id;
    await waitFor(async () => (await getBooking(id)).emailNotifications.filter(e => e.state === 'sent').length === 2);
    assert.equal(delivered.size, 2);
    assert.deepEqual(requests.map(r => r.body.to[0]).sort(), ['hhimanshu030@gmail.com', 'info@britinstitute.uk']);
    for (const request of requests) {
      assert.equal(request.path, '/emails');
      assert.equal(request.auth, 'Bearer test-key-no-real-email');
      assert.equal(request.body.from, 'Brit Institute <info@britinstitute.uk>');
      assert.equal(request.body.reply_to, 'info@britinstitute.uk');
      assert.match(request.body.text, /Awaiting mentor approval/);
      assert.match(request.body.text, /Europe\/London/);
      assert.match(request.body.html, /SQL &lt;revision&gt; &amp;/);
      assert.doesNotMatch(request.body.html, /<revision>/);
    }
    const stored = await getBooking(id);
    assert.equal(stored.emailNotifications.length, 4);
    for (const email of stored.emailNotifications.filter(e => e.kind === 'reminder')) {
      assert.equal(email.nextAttemptAt.getTime(), stored.dateTime.getTime() - 2 * 60 * 60_000);
    }
    const list = await h.request('GET', '/me');
    assert.equal(list.body.bookings[0].emailNotifications, undefined);
  });

  await t.test('reminders start at two hours, include current join link, and are not repeated', async () => {
    await reset();
    let booking = await quietBooking();
    await processBookingEmails(String(booking._id));
    const accepted = await h.request('PATCH', `/admin/${booking._id}`, { status: 'accepted', meetingLink: 'https://zoom.us/j/participant-test' }, h.mentor);
    assert.equal(accepted.status, 200);
    await Booking.updateOne({ _id: booking._id }, { zoomStartUrl: 'https://zoom.us/s/private-host-token' });
    const due = new Date(booking.dateTime.getTime() - 2 * 60 * 60_000);
    await processDueBookingEmails(new Date(due.getTime() - 1));
    assert.equal(requests.length, 2);
    await processDueBookingEmails(due);
    assert.equal(requests.length, 4);
    for (const request of requests.slice(2)) {
      assert.match(request.body.subject, /Reminder/);
      assert.match(request.body.text, /https:\/\/zoom.us\/j\/participant-test/);
      assert.doesNotMatch(request.body.text, /private-host-token/);
    }
    await processDueBookingEmails(due);
    await processBookingEmails(String(booking._id), due);
    assert.equal(requests.length, 4);
    booking = await getBooking(booking._id);
    assert.ok(booking.emailNotifications.every(e => e.state === 'sent' && e.providerId));
  });

  await t.test('multiple concurrent workers claim each email once', async () => {
    await reset();
    const booking = await quietBooking();
    await Promise.all(Array.from({ length: 8 }, () => processBookingEmails(String(booking._id))));
    assert.equal(requests.length, 2);
    assert.equal(delivered.size, 2);
  });

  await t.test('student and admin rescheduling replace only reminders and preserve confirmation delivery state', async () => {
    await reset();
    let booking = await quietBooking();
    await processBookingEmails(String(booking._id));
    const original = booking.dateTime;
    const confirmations = (await getBooking(booking._id)).emailNotifications.filter(e => e.kind === 'confirmation').map(e => String(e._id));
    let next = new Date(original.getTime() + 2 * 60 * 60_000);
    let response = await h.request('PATCH', `/${booking._id}/reschedule`, { dateTime: next.toISOString() });
    assert.equal(response.status, 200);
    booking = await getBooking(booking._id);
    assert.deepEqual(booking.emailNotifications.filter(e => e.kind === 'confirmation').map(e => String(e._id)), confirmations);
    assert.ok(booking.emailNotifications.filter(e => e.kind === 'confirmation').every(e => e.state === 'sent'));
    await processDueBookingEmails(new Date(original.getTime() - 2 * 60 * 60_000));
    assert.equal(requests.length, 2);
    next = new Date(next.getTime() + 2 * 60 * 60_000);
    response = await h.request('PATCH', `/admin/${booking._id}`, { dateTime: next.toISOString() }, h.mentor);
    assert.equal(response.status, 200);
    booking = await getBooking(booking._id);
    assert.equal(booking.emailNotifications.length, 4);
    assert.ok(booking.emailNotifications.filter(e => e.kind === 'confirmation').every(e => e.state === 'sent'));
    await processDueBookingEmails(new Date(next.getTime() - 2 * 60 * 60_000));
    assert.equal(requests.length, 4);
  });

  await t.test('cancellation, completion and past sessions suppress reminders', async () => {
    for (const terminal of ['cancelled', 'completed', 'past']) {
      await reset();
      const booking = await quietBooking();
      await processBookingEmails(String(booking._id));
      if (terminal === 'cancelled') assert.equal((await h.request('PATCH', `/${booking._id}/cancel`)).status, 200);
      if (terminal === 'completed') assert.equal((await h.request('PATCH', `/admin/${booking._id}`, { status: 'completed' }, h.mentor)).status, 200);
      await processDueBookingEmails(terminal === 'past' ? booking.dateTime : new Date(booking.dateTime.getTime() - 2 * 60 * 60_000));
      assert.equal(requests.length, 2);
      assert.ok((await getBooking(booking._id)).emailNotifications.filter(e => e.kind === 'reminder').every(e => e.state === 'skipped'));
    }
  });

  await t.test('late bookings send all four notifications immediately', async () => {
    await reset();
    const booking = await quietBooking(1);
    await processBookingEmails(String(booking._id));
    assert.equal(requests.length, 4);
    assert.equal(delivered.size, 4);
  });

  await t.test('provider failure never fails a booking; startup worker recovers persisted pending emails', async () => {
    await reset();
    config.resendApiKey = 'test-key-no-real-email';
    mode = 'outage';
    const response = await h.create();
    assert.equal(response.status, 201);
    await waitFor(async () => (await getBooking(response.body.booking._id)).emailNotifications.filter(e => e.lastError).length === 2);
    assert.equal(delivered.size, 0);
    mode = 'ok';
    // Read pending state afresh, as a restarted server does.
    await processDueBookingEmails(new Date(Date.now() + 2 * 60_000));
    assert.equal(delivered.size, 2);
    assert.equal((await getBooking(response.body.booking._id)).emailNotifications.filter(e => e.state === 'sent').length, 2);
  });

  await t.test('one failed recipient retries independently using Retry-After', async () => {
    await reset();
    const booking = await quietBooking();
    failLearnerOnce = true;
    const now = new Date();
    await processBookingEmails(String(booking._id), now);
    assert.equal(delivered.size, 1);
    await processBookingEmails(String(booking._id), new Date(now.getTime() + 119_999));
    assert.equal(requests.length, 2);
    await processBookingEmails(String(booking._id), new Date(now.getTime() + 120_000));
    assert.equal(requests.length, 3);
    assert.equal(delivered.size, 2);
    assert.equal(requests.filter(r => r.body.to[0] === 'info@britinstitute.uk').length, 1);
  });

  await t.test('lost provider responses retry the identical payload and key without duplicate delivery', async () => {
    await reset();
    const booking = await quietBooking();
    mode = 'ambiguous';
    const now = new Date();
    await processBookingEmails(String(booking._id), now);
    assert.equal(delivered.size, 2);
    await User.updateOne({ _id: h.learner._id }, { name: 'Updated Name' });
    mode = 'ok';
    await processBookingEmails(String(booking._id), new Date(now.getTime() + 60_000));
    assert.equal(delivered.size, 2);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[0].body, requests[2].body);
    assert.equal(requests[0].key, requests[2].key);
    await User.updateOne({ _id: h.learner._id }, { name: 'Email Test Learner' });
  });

  await t.test('100-email safety cap is atomic across workers and defers excess messages', async () => {
    await reset();
    const booking = await quietBooking();
    const day = new Date().toISOString().slice(0, 10);
    await SessionEmailQuota.create({ _id: day, keys: Array.from({ length: 99 }, (_, i) => `previous-${i}`), expiresAt: new Date(Date.now() + 86_400_000) });
    await Promise.all(Array.from({ length: 5 }, () => processBookingEmails(String(booking._id))));
    assert.equal(requests.length, 1);
    assert.equal((await SessionEmailQuota.findById(day)).keys.length, 100);
    const deferred = (await getBooking(booking._id)).emailNotifications.find(e => /daily safety limit/.test(e.lastError || ''));
    assert.ok(deferred);
    assert.equal(deferred.nextAttemptAt.getUTCHours(), 0);
  });

  await t.test('a reschedule loaded before confirmation delivery preserves the concurrent delivery result', async () => {
    await reset();
    const booking = await quietBooking();
    const controllerSnapshot = await getBooking(booking._id);
    await processBookingEmails(String(booking._id));
    controllerSnapshot.dateTime = new Date(controllerSnapshot.dateTime.getTime() + 60 * 60_000);
    resetBookingReminders(controllerSnapshot);
    await controllerSnapshot.save();
    const stored = await getBooking(booking._id);
    assert.ok(stored.emailNotifications.filter(e => e.kind === 'confirmation').every(e => e.state === 'sent' && e.providerId));
    await processBookingEmails(String(booking._id));
    assert.equal(requests.length, 2);
  });

  await t.test('an expired worker lease is recovered after a crash', async () => {
    await reset();
    const booking = await quietBooking();
    const now = new Date();
    await Booking.updateOne({ _id: booking._id }, { $set: {
      'emailNotifications.0.lockedUntil': new Date(now.getTime() + 60_000),
      'emailNotifications.0.lockToken': 'crashed-worker',
    } });
    await processDueBookingEmails(now);
    assert.equal(requests.length, 1);
    await processDueBookingEmails(new Date(now.getTime() + 60_000));
    assert.equal(requests.length, 2);
    assert.equal(delivered.size, 2);
  });

  await t.test('ambiguous retries stop before provider idempotency protection expires', async () => {
    await reset();
    const booking = await quietBooking(48);
    const now = new Date();
    mode = 'ambiguous';
    await processBookingEmails(String(booking._id), now);
    assert.equal(delivered.size, 2);
    mode = 'ok';
    await processBookingEmails(String(booking._id), new Date(now.getTime() + 23 * 60 * 60_000));
    assert.equal(requests.length, 2);
    assert.ok((await getBooking(booking._id)).emailNotifications.filter(e => e.kind === 'confirmation').every(e => e.state === 'failed'));
  });

  await t.test('summer session emails display UK daylight saving time', async () => {
    await reset();
    const year = new Date().getUTCFullYear() + 1;
    const booking = await quietBooking(4, { dateTime: `${year}-07-15T12:00:00.000Z` });
    await processBookingEmails(String(booking._id));
    assert.equal(requests.length, 2);
    assert.match(requests[0].body.text, /13:00 \(Europe\/London, UK time\)/);
  });

  await t.test('provider quota errors defer until UTC reset', async () => {
    await reset();
    const booking = await quietBooking();
    mode = 'quota';
    await processBookingEmails(String(booking._id));
    const emails = (await getBooking(booking._id)).emailNotifications.filter(e => e.kind === 'confirmation');
    assert.ok(emails.every(e => e.state === 'pending' && e.nextAttemptAt.getUTCHours() === 0));
  });

  await t.test('missing learner email does not block office notification and recovers after profile correction', async () => {
    await reset();
    const booking = await quietBooking(4, {}, h.other);
    const now = new Date();
    await processBookingEmails(String(booking._id), now);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.to[0], 'info@britinstitute.uk');
    await User.updateOne({ _id: h.other._id }, { email: 'hhimanshu030@gmail.com' });
    await processBookingEmails(String(booking._id), new Date(now.getTime() + 15 * 60_000));
    assert.equal(requests.length, 2);
  });

  await t.test('existing appointments receive no retroactive confirmation emails', async () => {
    await reset();
    await Booking.create({ student: h.learner._id, mentor: h.mentor._id, topic: 'Legacy appointment', dateTime: new Date(Date.now() + 60 * 60_000), status: 'pending' });
    config.resendApiKey = 'test-key-no-real-email';
    await processDueBookingEmails();
    assert.equal(requests.length, 0);
  });

  await t.test('booking auth, ownership and slot conflicts continue to work', async () => {
    await reset();
    const booking = await quietBooking();
    const response = await h.create(4, { dateTime: booking.dateTime.toISOString() });
    assert.equal(response.status, 409);
    assert.equal((await h.request('GET', '/me', undefined, null)).status, 401);
    assert.equal((await h.request('PATCH', `/admin/${booking._id}`, { status: 'completed' })).status, 403);
    assert.equal((await h.request('PATCH', `/${booking._id}/cancel`, {}, h.other)).status, 404);
    assert.equal(await Booking.countDocuments(), 1);
  });
});
