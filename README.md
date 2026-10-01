# WXShareRide

WXShareRide is the WeChat Mini Program and cloud backend behind **LinkX**. It brings ride offers, passenger requests, secondhand listings, and sublets into one community service, with a focus on the New York and New Jersey area.

## What the service includes

- **Ride offers and requests:** drivers publish available seats; passengers publish ride requests or join suitable trips. Capacity and membership are checked by the backend.
- **Practical ride browsing:** route and date filters, a shared calendar with daily offer/request counts, seat availability, and remembered preferences. Ride times use `America/New_York`.
- **Trip management:** participant details, trip history, completion counts, notifications, and blocking controls.
- **Community marketplace:** secondhand goods and sublet listings, images, location filters, and listing management.
- **Community notices:** announcements and contact/group QR images.

## Architecture

The Mini Program uses **JavaScript, WXML, and WXSS**. The released 5.1.0 client uses a single **Node.js 24/PostgreSQL** business backend on the Tencent Cloud server. CloudBase supplies WeChat identity and compatibility bridges to the same PostgreSQL database. A separate analytics collector receives batched events; public statistics come from the business backend. Seven retained legacy query functions also read PostgreSQL through restricted compatibility adapters. Their deployment boundaries and the retired CloudBase writers are documented in the [cloud function deployment guide](cloudfunctions/DEPLOYMENT.md).

The [management website](https://admin.linkx.ink/admin/) uses the same business backend. Its frontend is maintained in [LinkXweb](https://github.com/HotcatX/LinkXweb); ordinary administrators operate publishing and community notices, while `superadmin` can browse app-scoped data and bounded server monitoring. Host metrics are sampled every thirty seconds and retained for thirty days, without giving the backend Docker control.

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
| [`docs/`](docs/README.md) | Current feature guides, cutover evidence, and links to historical reports |

## Reading the implementation

Useful starting points:

- [Documentation index and historical reports](docs/README.md)
- [Shared ride calendars and form pickers](docs/ride-form-pickers.md)
- [Place recommendation design and catalog maintenance](docs/place-recommendations.md)
- [Community announcements and remote configuration](docs/community.md)
- [Ride completion statistics](docs/ride-completion-stats.md)
- [Production database cutover and verification](docs/backend-cutover-2026-09-30.md)
- [Public statistics operation and fallback](docs/public-statistics.md)
- [Canonical backend data contract](services/backend/SCHEMA.md)

Completed audits, old deployment checklists, and one-off fix reports are kept in Git history; the [documentation index](docs/README.md#历史报告) links to the fixed snapshot. Private migration exports and recovery material are described in `data/README.md` in the local checkout; they are excluded from Git and the Mini Program upload. Keep deploy/recovery tools and regression tests that cover current code; a legacy name alone does not prove an entry point is unused.

Some documentation is in Chinese.

## License

**All rights reserved. Source inspection only.** This project is provided for personal, noncommercial reading. Running, deploying, modifying, redistributing, or commercially using it requires separate written permission, subject to the rights and exceptions preserved in the [LICENSE](LICENSE).
