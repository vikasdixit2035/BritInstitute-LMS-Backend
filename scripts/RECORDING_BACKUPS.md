# Private recording backups

Zoom may return an HTML error page with HTTP 200 when its Cloud Recording plan
expires. The backend now rejects non-video responses instead of forwarding them
as MP4. A saved MP4 can restore playback independently of Zoom's availability.

Place backups in `uploads/recordings/<zoomRecordingFileId>.mp4` using the installer:

```powershell
node scripts/install-recording-backup.cjs 751a9f98-25ae-4031-a81d-c806a6db5273 "../outputs/powerbi-august-downloads/Power BI - Session 4 - DAX Query.mp4" aa524ee193ef29013c7ece9efd840c45780e6f72f52a42baefa9f5dfaf108502
```

Run this from the backend directory. The installer checks the expected SHA-256
and MP4 container before publishing a complete file. It never overwrites a
different existing backup. It does not change database records or progress.

Optionally set `RECORDING_MEDIA_DIR` to a persistent private directory. Do not
expose that directory through Express static hosting or a public web server.
The existing stream route checks the signed token, active user and batch access
before serving a backup. Byte ranges and HEAD requests are supported.

The 1 November 2026 September recording and August's Session 4 copy share the
file ID above. One installed backup serves both. Zoom metadata is retained, so
scheduled syncing does not replace this backup or disconnect the recordings.
Recordings without a saved file continue to use Zoom; they still require a
working Zoom Cloud Recording entitlement.

`uploads/` is ignored by Git. For deployment, copy the backup separately and
build/restart the backend. A source-only deployment will not contain the video.
No frontend change is required for saved-file playback.

Run `npm run test:recordings` for the isolated playback regression checks. They
use local HTTP fixtures and database doubles and never contact production.
