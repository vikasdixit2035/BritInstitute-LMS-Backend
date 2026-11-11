'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

// Isolated users and database operations; no production database is connected.
process.env.JWT_SECRET = 'recording-playback-test-secret';
process.env.ZOOM_ACCOUNT_ID = 'test-account';
process.env.ZOOM_CLIENT_ID = 'test-client';
process.env.ZOOM_CLIENT_SECRET = 'test-secret';
const { RecordedLecture } = require('../dist/models/RecordedLecture.model');
const { User } = require('../dist/models/User.model');
const { Batch } = require('../dist/models/Batch.model');
const { streamLecture } = require('../dist/controllers/recorded.controller');
const { fetchZoomRecordingFile, fetchZoomPublicRecordingFile, ZoomApiError } = require('../dist/services/zoom.service');
const { findLocalZoomRecording } = require('../dist/services/recordingPlayback.service');

test('protected recording playback', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lms-recording-playback-'));
  const originalMediaDir = process.env.RECORDING_MEDIA_DIR;
  process.env.RECORDING_MEDIA_DIR = directory;
  const fileId = '751a9f98-25ae-4031-a81d-c806a6db5273';
  const bytes = Buffer.alloc(4096, 23);
  bytes.write('ftypisom', 4);
  await fs.writeFile(path.join(directory, `${fileId}.mp4`), bytes);
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range, authorization: req.headers.authorization });
    if (req.url === '/oauth') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }));
    if (req.url === '/empty') return res.writeHead(204).end();
    if (req.url === '/error') return res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Recording is unavailable' }));
    if (req.url === '/html.mp4') return res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end('<html>Cloud Recording plan expired (200)</html>');
    const partial = req.headers.range === 'bytes=0-31';
    res.writeHead(partial ? 206 : 200, { 'Content-Type': req.url === '/binary' ? 'application/octet-stream' : 'video/mp4', ...(partial ? { 'Content-Range': `bytes 0-31/${bytes.length}` } : {}) });
    res.end(partial ? bytes.subarray(0, 32) : bytes);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${upstream.address().port}`;
  const nativeFetch = global.fetch;
  // Route OAuth to an actual local HTTP fixture. All video requests use native
  // fetch against the fixture too; no Zoom or LMS account is contacted.
  global.fetch = (url, options) => nativeFetch(String(url).startsWith('https://zoom.us/oauth/token?') ? `${sourceUrl}/oauth` : url, options);
  const originals = { user: User.findById, lecture: RecordedLecture.findById, batch: Batch.exists };
  let enrolled = true;
  let active = true;
  let source = 'zoom';
  User.findById = async () => active ? { isActive: true } : null;
  Batch.exists = async () => enrolled ? { _id: 'batch' } : null;
  RecordedLecture.findById = async id => ({ _id: id, batch: 'batch', recordingSource: source, recordingStatus: 'available', zoomRecordingFileId: id === 'missing' ? 'missing-backup' : fileId, zoomDownloadUrl: `${sourceUrl}/html.mp4`, videoUrl: `${sourceUrl}/html.mp4` });
  const app = express();
  app.get('/recorded/:id/stream', streamLecture);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streamUrl = (id, overrides = {}) => `${base}/recorded/${id}/stream?streamToken=${jwt.sign({ id: 'student', role: 'student', username: 'test-student', purpose: 'recorded-stream', lectureId: id, ...overrides }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;

  t.after(async () => {
    User.findById = originals.user;
    RecordedLecture.findById = originals.lecture;
    Batch.exists = originals.batch;
    global.fetch = nativeFetch;
    if (originalMediaDir === undefined) delete process.env.RECORDING_MEDIA_DIR;
    else process.env.RECORDING_MEDIA_DIR = originalMediaDir;
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    const resolvedDirectory = await fs.realpath(directory);
    assert.equal(path.dirname(resolvedDirectory), await fs.realpath(os.tmpdir()));
    assert(path.basename(resolvedDirectory).startsWith('lms-recording-playback-'));
    await fs.rm(resolvedDirectory, { recursive: true, force: true });
  });

  await t.test('serves a saved Zoom recording without contacting Zoom', async () => {
    const before = requests.length;
    const response = await fetch(streamUrl('september'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(requests.length, before);
  });
  await t.test('preserves byte-range seeking and shared August playback', async () => {
    for (const id of ['september', 'august']) {
      const response = await fetch(streamUrl(id), { headers: { Range: 'bytes=128-255' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 128-255/4096');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(128, 256));
    }
    const suffix = await fetch(streamUrl('september'), { headers: { Range: 'bytes=-32' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-32));
    const invalid = await fetch(streamUrl('september'), { headers: { Range: 'bytes=5000-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */4096');
    assert.match(invalid.headers.get('content-type'), /application\/json/);
  });
  await t.test('HEAD returns file metadata without a body', async () => {
    const response = await fetch(streamUrl('september'), { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '4096');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });
  await t.test('requires a valid lecture-specific token and active student', async () => {
    for (const url of [`${base}/recorded/september/stream`, streamUrl('september', { lectureId: 'other' }), streamUrl('september', { purpose: 'other' })]) {
      const response = await fetch(url);
      assert.equal(response.status, 401);
      await response.body.cancel();
    }
    active = false;
    const response = await fetch(streamUrl('september'));
    assert.equal(response.status, 401);
    await response.body.cancel();
    active = true;
  });
  await t.test('denies a student outside the batch', async () => {
    enrolled = false;
    const response = await fetch(streamUrl('september'));
    assert.equal(response.status, 403);
    await response.body.cancel();
    enrolled = true;
  });
  await t.test('rejects path traversal, missing files, directories and empty backups', async () => {
    for (const id of ['../secret', '..\\secret', '/secret', '', 'missing']) assert.equal(await findLocalZoomRecording(id), null);
    await fs.mkdir(path.join(directory, 'folder.mp4'));
    await fs.writeFile(path.join(directory, 'empty.mp4'), '');
    assert.equal(await findLocalZoomRecording('folder'), null);
    assert.equal(await findLocalZoomRecording('empty'), null);
  });
  await t.test('returns JSON 502 when Zoom returns HTML with HTTP 200', async () => {
    const response = await fetch(streamUrl('missing'), { headers: { Range: 'bytes=0-31' } });
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const error = await response.json();
    assert.match(error.message, /Zoom did not return a video/);
    assert.doesNotMatch(error.message, /<html>/);
    assert(requests.some(r => r.path === '/html.mp4' && r.range === 'bytes=0-31' && r.authorization === 'Bearer test-token'));
  });
  await t.test('rejects HTML returned for manually supplied MP4 URLs', async () => {
    source = 'manual';
    const response = await fetch(streamUrl('september'));
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type'), /application\/json/);
    await response.body.cancel();
    source = 'zoom';
  });
  await t.test('preserves authorized Zoom MP4 and range responses', async () => {
    const response = await fetchZoomRecordingFile(`${sourceUrl}/video`, 'bytes=0-31');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-31/4096');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 32));
  });
  await t.test('validates public Zoom downloads, empty and error responses', async () => {
    for (const endpoint of ['/html.mp4', '/empty', '/error']) await assert.rejects(fetchZoomPublicRecordingFile({ download_url: `${sourceUrl}${endpoint}` }), ZoomApiError);
    const response = await fetchZoomPublicRecordingFile({ download_url: `${sourceUrl}/binary` });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  });
  await t.test('streams the installed November recording when present', async localTest => {
    if (originalMediaDir === undefined) delete process.env.RECORDING_MEDIA_DIR;
    else process.env.RECORDING_MEDIA_DIR = originalMediaDir;
    try {
      const file = await findLocalZoomRecording(fileId);
      if (!file) return localTest.skip('No installed backup in this checkout');
      const size = (await fs.stat(file)).size;
      const handle = await fs.open(file, 'r');
      try {
        const first = Buffer.alloc(4096);
        const last = Buffer.alloc(4096);
        await handle.read(first, 0, first.length, 0);
        await handle.read(last, 0, last.length, size - last.length);
        assert(first.subarray(0, 64).includes(Buffer.from('ftyp')));
        const before = requests.length;
        for (const id of ['september', 'august']) {
          const response = await fetch(streamUrl(id), { headers: { Range: 'bytes=0-4095' } });
          assert.equal(response.status, 206);
          assert.equal(response.headers.get('content-type'), 'video/mp4');
          assert.equal(response.headers.get('content-range'), `bytes 0-4095/${size}`);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), first);
        }
        const response = await fetch(streamUrl('september'), { headers: { Range: 'bytes=-4096' } });
        assert.equal(response.status, 206);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), last);
        assert.equal(requests.length, before);
      } finally { await handle.close(); }
    } finally { process.env.RECORDING_MEDIA_DIR = directory; }
  });
});
