# Location configuration

Edit only the root `config/locationCatalog.json`. Run
`node services/backend/scripts/sync-location-catalog.mjs` to regenerate
exactly three committed deployment assets: `src/locations/catalog.generated.json`,
the mini-program's `utils/locationCatalog.generated.js`, and the independent
collector's `services/analytics-collector/src/place-catalog.cjs` (repository-relative).
The consistency check rejects drift. The backend Docker image packages only the
backend. Lookup behavior remains authored once in `utils/placeCatalog.js`; the
collector copy inlines the generated public catalog because its deployment cannot
require files from the repository root. No legacy cloud-function catalog bundle
is generated.

`GET /api/v1/locations` is a public, read-only configuration endpoint. Its data
contains the fixed place catalog, separate offer/request address options,
`cityTree` for service cities, `regionTree` for profile/admin region groups, and
`marketRegionTree` for market state/area selection. `regionTree` retains the
historical `OTHER` profile grouping; it is not a market state code. Consumers
writing market regions must use `marketRegionTree` and the market schema.

The initial configuration reconciles the existing fixed catalog with the
audited Departure/Arrival and Request options and preserves the public
CITY_TREE, cityTree, and regionTree configurations. It contains no user data.
Dynamic suggestions, rankings, selections, and follow-up outcomes continue to
use the existing collector; there is no second place fact table in PostgreSQL.
Invalid, missing, or empty packaged configuration fails validation. This module
never silently replaces a failed load with an empty successful response.

`requestPrices` contains the reviewed public request-route quote labels from the
legacy configuration (`fromAddress`, `toAddress`, `label`). Labels such as package
fares remain intact; they are not assumed to be per-passenger or actual paid prices.
Edit them only in the root catalog, then run the same synchronization script.
