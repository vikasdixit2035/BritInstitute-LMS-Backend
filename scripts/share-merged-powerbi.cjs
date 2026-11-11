#!/usr/bin/env node
'use strict';

// Run from the backend checkout on the VPS. No application build/restart needed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
const SHARE_KEY = 'august-september-powerbi-2026-10-24';
const CRON_MARKER = '# brit-lms-aug-sep-powerbi-2026';
const SOURCE_BATCH = '6a97f4d7bd2e6590ca0997ea';
const TARGET_BATCH = '6a44f992e1b5a650f9b984b7';
const FIRST_TARGET_TOPIC = '6a44f9c1e1b5a650f9b98566';
const DATES = Object.freeze([
  '2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01',
  '2026-11-07', '2026-11-08', '2026-11-14', '2026-11-15',
]);
const MEDIA_FIELDS = [
  'videoUrl', 'videoType', 'recordingSource', 'recordingStatus',
  'zoomRecordingFileId', 'zoomRecordingMeetingId', 'zoomDownloadUrl',
  'zoomPlayUrl', 'zoomShareUrl', 'recordingStartedAt', 'recordingCompletedAt',
  'uploadedBy',
];

function ukDate(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isAvailable(source) {
  return Boolean(source && source.videoUrl && source.uploadedBy
    && source.recordingStatus === 'available'
    && (source.recordingSource !== 'zoom' || source.zoomDownloadUrl));
}

function planSessions(classes, sources, topics) {
  if (topics.length < DATES.length) throw new Error('August Power BI must contain at least eight topics.');
  return DATES.map((date, index) => {
    const matches = classes.filter(cls => ukDate(cls.scheduledAt) === date);
    if (matches.length > 1) throw new Error(`Multiple September classes on ${date}; refusing to guess.`);
    const liveClass = matches[0];
    const recordings = liveClass ? sources.filter(lecture => String(lecture.liveClass) === String(liveClass._id)) : [];
    if (recordings.length > 1) throw new Error(`Multiple source recordings on ${date}; refusing to guess.`);
    const source = recordings[0];
    const topic = topics[index];
    const requestedTitles = { '2026-10-31': 'Modeling', '2026-11-01': 'DAX Query' };
    const subject = requestedTitles[date] || String(topic.title).replace(/^Class\s+\d+(?:\s*\([^)]*\))?:\s*/i, '');
    return {
      date, number: index + 1, liveClass, source, topic,
      title: `Power BI - Session ${index + 1}: ${subject}`,
      status: isAvailable(source) ? 'ready' : liveClass ? 'awaiting recording' : 'awaiting scheduled class',
    };
  });
}

function buildUpdate(session, targetBatch, curriculum, module, now = new Date()) {
  const set = {
    batch: targetBatch,
    title: session.title,
    description: `Power BI session ${session.number}, recorded on ${session.date}.`,
    order: new Date(session.liveClass.scheduledAt).getTime(),
    sharedSourceLecture: session.source._id,
    sharedSourceBatch: session.source.batch,
    sharedSourceDate: session.date,
    curriculumId: curriculum._id,
    curriculumModuleId: module._id,
    curriculumTopicId: session.topic._id,
    moduleTitle: module.title,
    updatedAt: now,
  };
  const unset = { liveClass: '' };
  for (const field of MEDIA_FIELDS) {
    if (session.source[field] !== undefined && session.source[field] !== null) set[field] = session.source[field];
    else unset[field] = '';
  }
  // sharedKey/sharedSession come from the upsert filter. The mirror has no
  // liveClass: that field is globally unique and belongs to September's original.
  return { $set: set, $unset: unset, $setOnInsert: { createdAt: now, __v: 0 } };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function withoutOurCron(text) {
  return text.split('\n').filter(line => !line.includes(CRON_MARKER)).filter(Boolean).join('\n');
}

function readCrontab() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot read crontab: ${result.error.message}`);
  if (result.status !== 0 && !/no crontab for/i.test(result.stderr || '')) {
    throw new Error(`Cannot read crontab: ${result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout || '';
}

function updateCron(install) {
  if (process.platform === 'win32') throw new Error('Cron installation must run on the Linux VPS.');
  let crontab = withoutOurCron(readCrontab());
  if (install) {
    const log = path.join(BACKEND_DIR, 'logs', 'merged-powerbi.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    // Cron treats % specially, even inside shell quotes; reject uncommon paths
    // instead of installing a command which would run differently than tested.
    const command = `${shellQuote(process.execPath)} ${shellQuote(__filename)} --apply >> ${shellQuote(log)} 2>&1`;
    if (/[\r\n%]/.test(command)) throw new Error('Backend and Node paths must not contain newlines or %.');
    crontab += `${crontab ? '\n' : ''}*/5 * * * * ${command} ${CRON_MARKER}`;
  }
  execFileSync('crontab', ['-'], { input: crontab ? `${crontab}\n` : '', encoding: 'utf8' });
  console.log(install ? 'Installed five-minute recording sync cron job.' : 'Removed recording sync cron job; copied recordings remain available.');
}

async function sync({ apply = false } = {}) {
  require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') });
  const mongoose = require('mongoose');
  if (!process.env.MONGO_URI) throw new Error(`MONGO_URI is missing from ${path.join(BACKEND_DIR, '.env')}`);
  const timeout = setTimeout(() => {
    console.error('Recording sync timed out after 60 seconds.');
    process.exit(1);
  }, 60000);
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: false, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
    });
    const db = mongoose.connection.db;
    const id = value => new mongoose.Types.ObjectId(value);
    const batches = db.collection('batches');
    const lectures = db.collection('recordedlectures');
    const sourceBatch = await batches.findOne({ _id: id(SOURCE_BATCH) });
    const targetBatch = await batches.findOne({ _id: id(TARGET_BATCH) });
    if (!sourceBatch || !targetBatch || String(sourceBatch.course) !== String(targetBatch.course)
      || ukDate(sourceBatch.startDate) !== '2026-09-19' || ukDate(targetBatch.startDate) !== '2026-08-01') {
      throw new Error('Batch IDs, courses or start dates do not match the verified August/September batches. No changes made.');
    }
    const curriculum = await db.collection('curriculums').findOne({ batch: targetBatch._id });
    const module = curriculum?.modules?.find(item => String(item.topics?.[0]?._id) === FIRST_TARGET_TOPIC);
    if (!module || !/power\s*bi/i.test(module.title)) {
      throw new Error('The verified August Power BI module was not found. No changes made.');
    }
    const classes = await db.collection('liveclasses').find({
      batch: sourceBatch._id,
      scheduledAt: { $gte: new Date('2026-10-23T23:00:00Z'), $lt: new Date('2026-11-16T00:00:00Z') },
    }).toArray();
    const sources = await lectures.find({
      batch: sourceBatch._id,
      liveClass: { $in: classes.map(cls => cls._id) },
    }).toArray();
    const plan = planSessions(classes, sources, module.topics);
    console.log(`[${new Date().toISOString()}] ${apply ? 'APPLY' : 'DRY RUN'}: September -> August Power BI`);
    for (const session of plan) console.log(`${session.date} | Session ${session.number} | ${session.status} | ${session.title}`);
    if (apply) {
      await lectures.createIndex({ sharedKey: 1, sharedSession: 1 }, {
        name: 'recording_share_session_unique', unique: true,
        partialFilterExpression: { sharedKey: { $type: 'string' } },
      });
      for (const session of plan.filter(item => item.status === 'ready')) {
        await lectures.updateOne(
          { sharedKey: SHARE_KEY, sharedSession: session.number },
          buildUpdate(session, targetBatch._id, curriculum, module),
          { upsert: true }
        );
      }
      const copies = await lectures.find({ batch: targetBatch._id, sharedKey: SHARE_KEY }).sort({ sharedSession: 1 }).toArray();
      console.log(`${copies.length}/8 recordings now present in August. Original September recordings unchanged.`);
      if (copies.length === 8 && plan.every(item => item.status === 'ready') && process.argv.includes('--apply')) {
        // Keep refreshing links for one week after the final class, then retire
        // this cron entry. Videos are retained permanently in both batches.
        if (Date.now() >= Date.parse('2026-11-23T00:00:00Z') && process.platform !== 'win32') updateCron(false);
      }
    } else {
      console.log('Preview only: no database or cron changes made.');
    }
    return plan;
  } finally {
    clearTimeout(timeout);
    await mongoose.disconnect();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valid = ['--dry-run', '--apply', '--install-cron', '--remove-cron'];
  if (args.some(arg => !valid.includes(arg)) || args.length > 1) {
    throw new Error('Usage: node scripts/share-merged-powerbi.cjs [--dry-run | --apply | --install-cron | --remove-cron]');
  }
  if (args.includes('--remove-cron')) return updateCron(false);
  if (args.includes('--install-cron')) {
    // Verify cron access before changing the database.
    if (process.platform === 'win32') throw new Error('Run --install-cron on the Linux VPS.');
    readCrontab();
    await sync({ apply: true });
    updateCron(true);
  } else {
    await sync({ apply: args.includes('--apply') });
  }
}

if (require.main === module) main().catch(error => {
  // Connection error messages can contain credentials: never echo the URI.
  let message = String(error.message || error);
  if (process.env.MONGO_URI) message = message.split(process.env.MONGO_URI).join('[MONGO_URI]');
  console.error(`Recording share failed: ${message}`);
  process.exitCode = 1;
});

module.exports = { DATES, ukDate, isAvailable, planSessions, buildUpdate, withoutOurCron, shellQuote };
