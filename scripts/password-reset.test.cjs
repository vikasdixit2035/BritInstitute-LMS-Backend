const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('email code resets the password once and the new credentials sign in', async t => {
  process.env.RESEND_API_KEY = 'local-test';
  const { User } = require('../dist/models/User.model');
  const routes = require('../dist/routes/auth.routes').default;
  const mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
  t.after(async () => { await mongoose.disconnect(); await mongo.stop(); });
  await mongoose.connect(mongo.getUri());
  const username = 'reset-student';
  const email = 'student@example.test';
  const oldPassword = 'PreviousPass1';
  const newPassword = 'ReplacementPass2';
  await User.create({ name: 'Test Student', username, email, password: oldPassword, password2: 'legacy-test-field' });

  const app = express();
  app.use(express.json());
  app.use('/auth', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const http = global.fetch;
  const mail = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    mail.push(JSON.parse(options.body));
    return Response.json({ id: 'mock-email' });
  });
  const post = (route, body) => http(`http://127.0.0.1:${server.address().port}/auth/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const request = () => post('forgot-password', { username });
  const reset = otp => post('reset-password', { username, otp, newPassword });
  const unknown = await post('forgot-password', { username: 'missing' });
  assert.equal(mail.length, 0);
  assert.deepEqual(await (await request()).json(), await unknown.json());
  await request();
  assert.equal(mail.length, 1);
  assert.deepEqual(mail[0].to, [email]);
  const code = () => mail.at(-1).text.match(/\b\d{6}\b/)[0];
  const wrong = code() === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await reset(wrong)).status, 400);
  assert.equal((await reset(code())).status, 400);
  await User.updateOne({ username }, { $set: { 'passwordReset.sentAt': new Date(0) } });
  await request();
  assert.equal(mail.length, 2);
  const concurrent = await Promise.all([reset(code()), reset(code())]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 400]);
  assert.equal((await reset(code())).status, 400);
  assert.equal((await post('login', { username, password: oldPassword })).status, 401);
  assert.ok((await (await post('login', { username, password: newPassword })).json()).token);
  await request();
  await User.updateOne({ username }, { $set: { 'passwordReset.expiresAt': new Date(0) } });
  assert.equal((await reset(code())).status, 400);
});
