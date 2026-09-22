# WXShareRide

WXShareRide is the WeChat Mini Program and cloud backend behind **LinkX**. It brings ride offers, passenger requests, secondhand listings, and sublets into one community service, with a focus on the New York and New Jersey area.

## What the service includes

- **Ride offers and requests:** drivers publish available seats; passengers publish ride requests or join suitable trips. Capacity and membership are checked by the backend.
- **Practical ride browsing:** route and date filters, a shared calendar with daily offer/request counts, seat availability, and remembered preferences. Ride times use `America/New_York`.
- **Trip management:** participant details, trip history, completion counts, notifications, and blocking controls.
- **Community marketplace:** secondhand goods and sublet listings, images, location filters, and listing management.
- **Community notices:** announcements and contact/group QR images.

## Architecture

The Mini Program uses **JavaScript, WXML, and WXSS**. Its **Node.js cloud functions** run on **Tencent CloudBase**, using cloud database and storage services.

| Location | Contents |
| --- | --- |
| [`pages/`](pages/) | Ride, marketplace, account, and trip-management screens |
| [`components/`](components/) | Shared calendar, time picker, announcement, and other UI components |
| [`utils/`](utils/) | Time-zone handling, caching, location choices, and client helpers |
| [`cloudfunctions/`](cloudfunctions/) | Cloud functions for rides, accounts, and marketplace operations |
| [`styles/`](styles/) and [`templates/`](templates/) | Shared presentation and templates |
| [`tests/`](tests/) | Automated regression tests |
| [`docs/`](docs/) | Architecture notes, maintenance records, and feature documentation |

## Reading the implementation

Useful starting points:

- [Shared ride calendars and form pickers](docs/ride-form-pickers-2026-09-11.md)
- [Community announcements and remote configuration](docs/community-hot-update.md)
- [Ride completion statistics](docs/ride-completion-stats.md)

Some documentation is in Chinese.

## License

**All rights reserved. Source inspection only.** This project is provided for personal, noncommercial reading. Running, deploying, modifying, redistributing, or commercially using it requires separate written permission, subject to the rights and exceptions preserved in the [LICENSE](LICENSE).
