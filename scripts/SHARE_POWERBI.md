# August / September Power BI recordings

Copy `share-merged-powerbi.cjs` into the **scripts** directory of the backend
checkout on your Linux VPS. The backend's existing `mongoose`, `dotenv`, and
`.env` are used. Node 18+ and Linux `crontab` are required.

Run as the same server user that normally runs the LMS backend:

```bash
cd /path/to/BritInstitute-LMS-Backend
node scripts/share-merged-powerbi.cjs --dry-run
node scripts/share-merged-powerbi.cjs --install-cron
```

The first command only previews the mapping. The second copies available
recordings immediately and installs a job that checks every five minutes.
No frontend deployment, backend build, or application restart is needed.

| September class date (UK) | August Power BI session |
| --- | --- |
| 24 October 2026 | 1 |
| 25 October 2026 | 2 |
| 31 October 2026 | 3 |
| 1 November 2026 | 4 |
| 7 November 2026 | 5 |
| 8 November 2026 | 6 |
| 14 November 2026 | 7 |
| 15 November 2026 | 8 |

The verified September and August batch IDs, course, start dates, and August's
first Power BI topic are checked before writing. Source recordings are selected
by the live class's scheduled date in Europe/London, never its name or class
number. If multiple source classes exist on a selected date, the script stops
without guessing. Weekdays, earlier Excel classes, and later weekends are excluded.

The first two recordings were confirmed available in the configured database on
27 October 2026. The other six are copied once their September classes have been
scheduled and their recordings are available. Keep creating/scheduling those
classes in September as usual; the script does not create Zoom meetings.

Each copy belongs to August, has a new lecture ID and independent student
progress, and is titled `Power BI - Session 1: ...` through session 8. Copies
also store the corresponding August curriculum/topic IDs. The existing frontend
displays these titles in Recorded lectures; this script does not add a new
module-grouping UI or alter curriculum/live-class schedules. September's originals
remain untouched. Refresh the student dashboard after the first run.

Repeated runs update the same eight copies, enforced by a unique database index.
Only this job's cron entry is replaced when reinstalling. Logs are written to
`logs/merged-powerbi.log` inside the backend directory.

Once all eight recordings exist, the job removes its own cron entry on or after
23 November 2026. Copies remain available permanently. If some are still missing,
it continues waiting for those exact dates; it never substitutes later classes.

To stop automatic checks while retaining copied videos:

```bash
node scripts/share-merged-powerbi.cjs --remove-cron
```

To perform one manual sync without installing cron:

```bash
node scripts/share-merged-powerbi.cjs --apply
```

The cron installation command must be rerun if the backend checkout or Node
binary is moved. The database user needs permission to insert/update recordings
and create the unique index. No credentials are embedded in this script.
