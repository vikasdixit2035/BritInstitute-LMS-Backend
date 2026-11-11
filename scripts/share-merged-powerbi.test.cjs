'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DATES, ukDate, isAvailable, planSessions, buildUpdate, withoutOurCron, shellQuote } = require('./share-merged-powerbi.cjs');

const topics = Array.from({ length: 10 }, (_, i) => ({ _id: `topic-${i + 1}`, title: `Class ${i + 1} (Week 4 - Saturday): Subject ${i + 1}` }));
const liveClass = { _id: 'source-class', scheduledAt: new Date('2026-10-24T16:00:00Z') };
const source = {
  _id: 'source-lecture', batch: 'september', liveClass: 'source-class',
  title: 'Class 11 - Class 5: Business KPI Measures',
  videoUrl: 'https://example.invalid/video.mp4', videoType: 'zoom',
  recordingSource: 'zoom', recordingStatus: 'available',
  zoomDownloadUrl: 'https://example.invalid/download.mp4', uploadedBy: 'teacher',
};

test('contains exactly four weekends and stops on November 15', () => {
  assert.equal(DATES.length, 8);
  assert.equal(new Set(DATES).size, 8);
  assert.equal(DATES[0], '2026-10-24');
  assert.equal(DATES[7], '2026-11-15');
  assert.deepEqual(DATES.map(date => new Date(`${date}T12:00:00Z`).getUTCDay()), [6, 0, 6, 0, 6, 0, 6, 0]);
});

test('uses London calendar dates across the October clock change', () => {
  assert.equal(ukDate('2026-10-23T23:30:00Z'), '2026-10-24');
  assert.equal(ukDate('2026-10-25T00:30:00Z'), '2026-10-25');
  assert.equal(ukDate('2026-10-25T23:30:00Z'), '2026-10-25');
});

test('maps mislabeled source class 5 to August session 1 by date', () => {
  const plan = planSessions([liveClass], [source], topics);
  assert.equal(plan[0].source._id, 'source-lecture');
  assert.equal(plan[0].title, 'Power BI - Session 1: Subject 1');
  assert.equal(plan[0].status, 'ready');
  assert.equal(plan[1].status, 'awaiting scheduled class');
});

test('excludes earlier Excel and later sessions, and does not shift missing dates', () => {
  const classes = [
    { _id: 'old', scheduledAt: new Date('2026-10-18T16:00:00Z') },
    { _id: 'future', scheduledAt: new Date('2026-11-21T17:00:00Z') },
    { _id: 'third', scheduledAt: new Date('2026-10-31T17:00:00Z') },
  ];
  const plan = planSessions(classes, [
    { ...source, liveClass: 'old' }, { ...source, liveClass: 'future' }, { ...source, liveClass: 'third' },
  ], topics);
  assert.equal(plan[0].source, undefined);
  assert.equal(plan[2].source.liveClass, 'third');
  assert.equal(plan.filter(session => session.status === 'ready').length, 1);
});

test('refuses ambiguous classes or recordings instead of guessing', () => {
  assert.throws(() => planSessions([liveClass, { ...liveClass, _id: 'duplicate' }], [source], topics), /Multiple September classes/);
  assert.throws(() => planSessions([liveClass], [source, { ...source, _id: 'duplicate' }], topics), /Multiple source recordings/);
});

test('processing or incomplete Zoom recordings are not published', () => {
  assert.equal(isAvailable({ ...source, recordingStatus: 'pending' }), false);
  assert.equal(isAvailable({ ...source, zoomDownloadUrl: '' }), false);
  assert.equal(isAvailable(undefined), false);
  assert.equal(isAvailable(source), true);
});

test('copies media with August identity and clears stale media fields', () => {
  const session = planSessions([liveClass], [source], topics)[0];
  const update = buildUpdate(session, 'august', { _id: 'curriculum' }, { _id: 'module', title: 'Power BI' });
  assert.equal(update.$set.batch, 'august');
  assert.equal(update.$set.sharedSourceLecture, 'source-lecture');
  assert.equal(update.$set.zoomDownloadUrl, source.zoomDownloadUrl);
  assert.equal(update.$set.curriculumTopicId, 'topic-1');
  assert.equal(update.$set._id, undefined);
  assert.equal(update.$set.liveClass, undefined);
  assert.equal(update.$set.isCompleted, undefined);
  assert.equal(update.$unset.liveClass, '');
  assert.equal(update.$unset.zoomPlayUrl, '');
  assert.equal(source.batch, 'september');
});

test('cron replacement preserves unrelated entries and quotes paths', () => {
  const unrelated = '0 1 * * * /usr/bin/backup # nightly';
  assert.equal(withoutOurCron(`${unrelated}\n*/5 * * * * old-command # brit-lms-aug-sep-powerbi-2026\n`), unrelated);
  assert.equal(shellQuote("/a path/it's-node"), "'/a path/it'\"'\"'s-node'");
});
