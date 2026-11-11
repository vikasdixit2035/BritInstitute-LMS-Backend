# Booking email verification

Verified on 11 November 2026.

- `npm run test:booking-emails`: exit 0, 19 passing tests (18 lifecycle cases plus the parent test), real HTTP booking routes and disposable MongoDB, local Resend HTTP fixture.
- `npm run test:recordings`: exit 0, 12 passing tests, preserving the existing recording behavior.
- Frontend `npm run build`: exit 0; backend TypeScript build also passed.
- Resend domain API: `britinstitute.uk` reported `verified`.
- `npm run test:booking-emails:live -- --send-live-test-emails`: exit 0. Four real test emails were accepted by Resend and all four subsequently reported `last_event: delivered`.

| Email | Recipient | Resend ID | Observed event |
| --- | --- | --- | --- |
| Booking confirmation | hhimanshu030@gmail.com | 01a1cab2-e137-78f7-97e4-70174a51ef1f | delivered |
| Booking confirmation | info@britinstitute.uk | 01a1cab2-e272-70dc-945a-f83983c0655b | delivered |
| Session reminder | hhimanshu030@gmail.com | 01a1cab2-e602-7971-842d-22d05bbaa295 | delivered |
| Session reminder | info@britinstitute.uk | 01a1cab2-e789-7c9f-8c7a-c8f53dfc7c0a | delivered |

All four used sender `Brit Institute <info@britinstitute.uk>`. The live test created an explicitly labelled test appointment in a disposable MongoDB and advanced only the reminder worker's input clock to exercise the two-hour boundary. It did not wait two wall-clock hours, change the machine clock, create a Zoom meeting, or access the real LMS database. Provider delivery events establish receiving-server delivery, not that a human opened the messages or their inbox placement.

The installed workspace has no Postman CLI. The checked-in Node HTTP fixture models Resend's documented send, error and idempotency responses. The passing fixture run establishes the application's behavior for those scenarios; the separate live run establishes actual Resend sending and delivery. No browser UI automation or production deployment was performed. Production activation requires the Resend key in the server environment, a backend build, and a restart of its existing process.
