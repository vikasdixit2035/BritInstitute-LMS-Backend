'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function main() {
  const [fileId, source, expectedHash] = process.argv.slice(2);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fileId || '') || !source || !/^[a-f0-9]{64}$/i.test(expectedHash || '')) {
    throw new Error('Usage: node scripts/install-recording-backup.cjs <Zoom-file-id> <source.mp4> <expected-sha256>');
  }
  const sourcePath = path.resolve(source);
  if (!sourcePath.toLowerCase().endsWith('.mp4')) throw new Error('The backup must be an MP4 file');
  if (await sha256(sourcePath) !== expectedHash.toLowerCase()) throw new Error('The source checksum does not match');
  const header = Buffer.alloc(64);
  const handle = await fs.promises.open(sourcePath, 'r');
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (!header.includes(Buffer.from('ftyp'))) throw new Error('The source is not an MP4 container');

  const directory = path.resolve(process.env.RECORDING_MEDIA_DIR || path.join(__dirname, '..', 'uploads', 'recordings'));
  await fs.promises.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${fileId}.mp4`);
  if (fs.existsSync(destination)) {
    if (await sha256(destination) !== expectedHash.toLowerCase()) throw new Error('A different backup already exists; it was not overwritten');
    console.log(JSON.stringify({ fileId, installed: true, alreadyPresent: true }));
    return;
  }
  // Publish only a complete, verified file, so concurrent playback cannot read
  // a partially copied MP4. Linking the temporary copy also prevents overwrite.
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    if (await sha256(temporary) !== expectedHash.toLowerCase()) throw new Error('The copied backup checksum does not match');
    await fs.promises.link(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  console.log(JSON.stringify({ fileId, installed: true, bytes: (await fs.promises.stat(destination)).size }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
