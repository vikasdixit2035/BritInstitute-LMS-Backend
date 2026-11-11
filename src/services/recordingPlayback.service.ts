import { stat } from 'fs/promises';
import path from 'path';

// This directory must remain private: files are served only after the stream
// controller has checked the token and the student's batch membership.
export const findLocalZoomRecording = async (fileId?: string): Promise<string | null> => {
  if (!fileId || !/^[a-zA-Z0-9_-]{1,128}$/.test(fileId)) return null;

  const directory = process.env.RECORDING_MEDIA_DIR || path.resolve(__dirname, '..', '..', 'uploads', 'recordings');
  const filePath = path.resolve(directory, `${fileId}.mp4`);
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0 ? filePath : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return null;
    throw error;
  }
};

export const isVideoStreamResponse = (response: globalThis.Response): boolean => {
  const mediaType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return Boolean(response.body) && (mediaType.startsWith('video/') || mediaType === 'application/octet-stream');
};
