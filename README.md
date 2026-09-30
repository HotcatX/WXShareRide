# WXShareRide

WXShareRide is the WeChat Mini Program and cloud backend behind **LinkX**. It brings ride offers, passenger requests, secondhand listings, and sublets into one community service, with a focus on the New York and New Jersey area.

## What the service includes

- **Ride offers and requests:** drivers publish available seats; passengers publish ride requests or join suitable trips. Capacity and membership are checked by the backend.
- **Practical ride browsing:** route and date filters, a shared calendar with daily offer/request counts, seat availability, and remembered preferences. Ride times use `America/New_York`.
- **Trip management:** participant details, trip history, completion counts, notifications, and blocking controls.
- **Community marketplace:** secondhand goods and sublet listings, images, location filters, and listing management.
- **Community notices:** announcements and contact/group QR images.

## Architecture

The Mini Program uses **JavaScript, WXML, and WXSS**. Production business operations use a single **Node.js 24/PostgreSQL** backend on the Tencent Cloud server. CloudBase retains the WeChat identity bridge and compatibility entry points; those entry points use the same PostgreSQL database. A separate analytics collector receives batched events. Public statistics come directly from the business backend.

| Location | Contents |
| --- | --- |
| [`pages/`](pages/) | Ride, marketplace, account, and trip-management screens |
| [`components/`](components/) | Shared calendar, time picker, announcement, and other UI components |
| [`utils/`](utils/) | Time-zone handling, caching, location choices, and client helpers |
| [`cloudfunctions/`](cloudfunctions/) | WeChat identity and compatibility entry points; restricted deployment list |
| [`services/backend/`](services/backend/) | Production business backend, canonical schema and isolated PostgreSQL tests |
| [`services/analytics-collector/`](services/analytics-collector/) | Deployed telemetry receiver, local operations and backup tools |
| [`styles/`](styles/) and [`templates/`](templates/) | Shared presentation and templates |
| [`tests/`](tests/) | Automated regression tests |
| [`docs/`](docs/) | Architecture notes, maintenance records, and feature documentation |

## Reading the implementation

Useful starting points:

- [Shared ride calendars and form pickers](docs/ride-form-pickers-2026-09-11.md)
- [Place recommendation design and catalog maintenance](docs/place-recommendation-and-data-plan-2026-09-23.md)
- [Community announcements and remote configuration](docs/community-hot-update.md)
- [Ride completion statistics](docs/ride-completion-stats.md)
- [Production database cutover and verification](docs/backend-cutover-2026-09-30.md)
- [Public statistics operation and fallback](docs/public-statistics.md)
- [Canonical backend data contract](services/backend/SCHEMA.md)

Historical one-off experiment reports and retired duplicate notes are kept in Git history. Keep deploy/recovery tools and regression tests that cover current code; a legacy name alone does not prove an entry point is unused.

Some documentation is in Chinese.

## License

**All rights reserved. Source inspection only.** This project is provided for personal, noncommercial reading. Running, deploying, modifying, redistributing, or commercially using it requires separate written permission, subject to the rights and exceptions preserved in the [LICENSE](LICENSE).
