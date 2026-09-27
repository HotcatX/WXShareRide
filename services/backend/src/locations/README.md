# Location configuration

Edit only the root `config/locationCatalog.json`. Run
`node services/backend/scripts/sync-location-catalog.mjs` to regenerate
`src/locations/catalog.generated.json` and the mini-program's
`utils/locationCatalog.generated.js`, plus the self-contained `placeCatalog.js`
bundles in the five legacy ride cloud functions and the independent collector. These are committed deployment assets;
the consistency test rejects drift. Docker continues packaging only the backend.
Lookup behavior remains authored once in `utils/placeCatalog.js`; cloud bundles
inline the generated fixed catalog because CloudBase deploys each function folder
independently. Do not copy the mini-program's `require` into those bundles.

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
