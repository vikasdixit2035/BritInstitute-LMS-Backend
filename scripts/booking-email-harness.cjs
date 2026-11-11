'use strict';
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
process.env.MONGOMS_DOWNLOAD_DIR = path.join(__dirname, '../node_modules/.cache/mongodb-binaries');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { config } = require('../dist/config/env');
const { User } = require('../dist/models/User.model');
const { Booking } = require('../dist/models/Booking.model');
const { SessionEmailQuota } = require('../dist/models/SessionEmailQuota.model');
const routes = require('../dist/routes/booking.routes').default;

async function startHarness() {
  // Deliberately never use MONGO_URI: all test data belongs to a disposable DB.
  const mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  await mongoose.connect(mongo.getUri(), { dbName: 'lms_booking_email_test' });
  await Promise.all([User.init(), Booking.init(), SessionEmailQuota.init()]);
  const learner = await User.create({ name: 'Email Test Learner', username: 'email-test-learner', email: 'hhimanshu030@gmail.com', password: 'test-password-only', role: 'student' });
  const mentor = await User.create({ name: 'Email Test Mentor', username: 'email-test-mentor', password: 'test-password-only', role: 'teacher' });
  const other = await User.create({ name: 'Other Learner', username: 'other-test-learner', password: 'test-password-only', role: 'student' });
  const token = user => jwt.sign({ id: String(user._id), role: user.role, username: user.username }, config.jwtSecret);
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', routes);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sessions`;
  const request = async (method, route, body, user = learner) => {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async (hours = 4, extra = {}, user = learner) => {
    const date = new Date(Date.now() + hours * 60 * 60_000);
    date.setSeconds(0, 0);
    return request('POST', '', { mentor: String(mentor._id), topic: 'SQL <revision> & project discussion', dateTime: date.toISOString(), duration: 30, ...extra }, user);
  };
  return { learner, mentor, other, request, create, close: async () => {
    await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  } };
}

async function waitFor(check, message = 'expected state') {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
module.exports = { startHarness, waitFor, config, User, Booking, SessionEmailQuota };
