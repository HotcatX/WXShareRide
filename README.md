# WXShareRide

**Community carpooling and everyday sharing, built for WeChat.**

WXShareRide is the WeChat Mini Program and cloud backend behind **LinkX (极链行服务)**. It brings ride offers, passenger requests, secondhand listings, and sublets into one community service, with a focus on the New York and New Jersey area.

> **Source inspection only — all rights reserved.** This is proprietary, source-visible software, not an open-source project. Public availability does not grant permission to run, deploy, modify, redistribute, or commercially use the project. Read the [LICENSE](LICENSE) before using any material.

## What the service includes

- **Ride offers and requests:** drivers publish available seats; passengers publish ride requests or join suitable trips. Capacity and membership are checked by the backend.
- **Practical ride browsing:** route and date filters, a shared calendar with daily offer/request counts, seat availability, and remembered preferences. Ride times use `America/New_York`.
- **Trip management:** participant details for authorized users, trip history, completion counts, notifications, and blocking controls.
- **Community marketplace:** secondhand goods and sublet listings, images, location filters, and listing management.
- **Community notices:** remotely managed announcements and contact/group QR images, with display schedules and frequency limits.
- **Separate web access paths:** limited public browsing and authenticated administration, backed by the same CloudBase environment.

## Architecture

The Mini Program uses **JavaScript, WXML, and WXSS**. Its **Node.js cloud functions** run on **Tencent CloudBase**, using cloud database and storage services. WeChat identity, website administrator sessions, and the public website read API have separate authorization paths.

| Location | Contents |
| --- | --- |
| [`pages/`](pages/) | Ride, marketplace, account, and trip-management screens |
| [`components/`](components/) | Shared calendar, time picker, announcement, and other UI components |
| [`utils/`](utils/) | Time-zone handling, caching, location choices, and client helpers |
| [`cloudfunctions/`](cloudfunctions/) | Cloud functions for rides, accounts, marketplace operations, and web access |
| [`styles/`](styles/) and [`templates/`](templates/) | Shared presentation and templates |
| [`tests/`](tests/) | Automated regression tests |
| [`docs/`](docs/) | Architecture notes, maintenance records, and feature documentation |

The website and its administrator interface are maintained separately in [LinkXweb](https://github.com/HotcatX/LinkXweb). This repository contains the Mini Program and backend, including the website's backend handlers in `cloudfunctions/marketApi/`.

## Reading the implementation

Useful starting points:

- [Public website API and its authorization boundary](docs/public-web-api.md)
- [Website administration and image uploads](docs/web-admin-migration.md)
- [Shared ride calendars and form pickers](docs/ride-form-pickers-2026-09-11.md)
- [Community announcements and remote configuration](docs/community-hot-update.md)
- [Ride completion statistics](docs/ride-completion-stats.md)

Some maintenance documents are in Chinese. Operational instructions in this repository are for separately authorized maintainers; their presence does not grant deployment permission or access to production systems.

## Permissions and licensing

The [Proprietary Source-Viewing Terms](LICENSE) apply to first-party material covered by those terms:

| Activity | Permission |
| --- | --- |
| Read and inspect source for personal, noncommercial understanding | Permitted under the LICENSE |
| Build, run, deploy, or host the software | Separate written permission required |
| Copy code into another project, modify it, or create derivative works | Separate written permission required |
| Redistribute, sell, sublicense, or use it in a commercial product or service | Separate written permission required |

These restrictions are subject to the rights expressly preserved in the LICENSE, including GitHub's applicable Terms of Service, legal exceptions, third-party licenses, and valid earlier permissions. GitHub may allow viewing, downloading, and forking as platform features; technical availability is not a general reuse license. Rights granted by GitHub's applicable terms remain unaffected.

**Public visitors have no push access to this repository.** Existing authorized collaborators retain their assigned repository permissions and work within their separately agreed scope. Public visibility and collaborator access do not grant general rights to reuse the project or access its live databases, credentials, or administrator accounts.

Some earlier package metadata declared ISC. These new terms do not retroactively revoke any rights validly granted under an earlier license. Dependencies and other third-party material retain their own licenses; the repository's restrictions do not replace them.

For additional permission, contact the repository owner, [HotcatX](https://github.com/HotcatX), and obtain a written grant covering the intended use.
