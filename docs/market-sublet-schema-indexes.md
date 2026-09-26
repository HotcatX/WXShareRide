# Market Sublet Schema And Indexes

The market feature stores both second-hand goods and sublets in `market_goods`.
Legacy goods documents may not have `listingType`; the app treats missing or empty
`listingType` as `goods`.

## `market_goods` Fields

Shared fields:

- `listingType`: `goods` or `sublet`.
- `title`: listing title.
- `price`: number. For `sublet`, this is monthly rent.
- `category`: goods category or sublet room type.
- `region`: display location string.
- `location`: structured location object with `displayName`, `lat`, `lng`, etc.
- `desc`: description.
- `status`: `online`, `offline`, or `sold`.
- `createTime`, `updateTime`: server dates.
- `pickupStartDate`, `pickupEndDate`, `pickupRangeText`, `expireTime`, `expiresAtText`: availability window.
- `imageFileID`, `thumbFileID`, `imageFileIDs`, `thumbFileIDs`, `hasImage`: storage references.
- `_openid`: ordinary publisher. Website-managed listings use verified
  `ownerKey`/`managedByAccountId` instead; do not manufacture an OpenID.

Sublet-only fields:

- `availableStartDate`: move-in date, mirrored from `pickupStartDate`.
- `leaseEndDate`: lease end date, mirrored from `pickupEndDate`.
- `deposit`: number or empty string.
- `roomType`: usually mirrors the selected sublet `category`.
- `housingType`: apartment, condo, house, dorm, or custom text.
- `furnished`: boolean.
- `utilitiesIncluded`: boolean.
- `genderPreference`: roommate preference text.
- `roommateCount`: integer or empty string.

## CloudBase Index History

Historical record: created in `cloud1-7gmtcu4s3aebce27` on 2026-06-20 with CloudBase CLI.
`market_goods` went from 9 to 23 indexes. `MarketFiles` went from 5 to 7 indexes,
with one existing index reported by the CLI. This is not a current inventory or
an instruction to recreate retired indexes. The current source uses the following
fields; verify actual query plans before changing production indexes.

- `listingType ASC, status ASC, createTime DESC`
- `listingType ASC, status ASC, category ASC, createTime DESC`
- `listingType ASC, status ASC, region ASC, createTime DESC`
- `_openid ASC, listingType ASC, createTime DESC`
- `_openid ASC, listingType ASC, status ASC, createTime DESC`
- `_openid ASC, status ASC, createTime DESC`
- `buyerOpenid ASC, status ASC, createTime DESC`

Recommended indexes on `MarketFiles`:

- `fileID ASC, _openid ASC`
- `goodsId ASC, status ASC`
- `_openid ASC, status ASC, updatedAtMs DESC`

## API and Local Verification

- `marketApi` `create` writes `listingType: "sublet"` and normalizes numbers/booleans.
- `marketApi` `list` with `filters.listingType: "sublet"` returns the record.
- `marketApi` `detail` returns `leaseText`, `depositText`, `subletMetaList`, and `/月` display helpers.
- `marketApi` `myList` and `sellerList` filter by `listingType`.
- The repository's `marketApi` `delete` removes the document before marking
  `MarketFiles` for later cleanup. `update` marks only removed references.
  Neither operation physically deletes images; `deletedFiles: 0` and
  `failedFiles: []` retain the existing response shape.

Images can be shared by multiple listings. A `deleted` ledger status is removal
intent, not proof that the object is unreferenced. `cleanupMarketImages` checks
references before status and blocks the entire deletion pass on incomplete or
failed scans. These scans are not an atomic snapshot: concurrent new references
still need the new backend's shared file-locking protocol before migration.
Do not switch its reference source to an empty or partially migrated database.

Run synthetic regression fixtures locally; do not create test listings in the
production collection. These source changes need their own verified deployment.

```sh
node --test tests/market-file-removal.test.cjs tests/market-image-cleanup.test.cjs tests/market-post-image-upload.test.cjs tests/web-admin.test.cjs
```

The new backend's field and migration contract is maintained only in
[SCHEMA.md](../services/backend/SCHEMA.md); this document describes CloudBase.

## `market_ads` Fields

Market feed ads are independent from `market_goods`. Goods and sublets share the
same `market_ads` pool and card style. The mini program reads ads through
`marketApi` action `listAds`, caches them locally, then inserts at most one ad
card into the rendered feed. Ads do not have a detail page.

Recommended fields:

- `status`: `online` to show; any other value is ignored.
- `placement`: currently `market_feed`.
- `title`: card title.
- `subtitle`: optional internal/admin note or future second line.
- `badgeText`: defaults to `广告`.
- `ctaText`: defaults to `查看`.
- `imageFileID`: cloud storage file ID for the main creative.
- `thumbFileID`: optional cloud storage file ID for a smaller creative.
- `imageUrl`: optional direct image URL fallback.
- `targetType`: `page`, `tab`, `miniProgram`, `web`, `copy`, `contact`,
  `serviceChat`, `copyWechat`, or `none`.
- `targetPath`: mini program page path, tab path, or mini-program path.
- `targetUrl`: external URL. The client opens it through
  `pages/other/webview/webview`; the URL domain must be configured as a WeChat
  mini program business domain.
- `targetAppId`: target mini program appId when `targetType` is `miniProgram`.
- `targetExtraData`: optional object passed to `wx.navigateToMiniProgram`.
- `contactSessionFrom`: optional source string for `targetType: "contact"`.
- `contactMessageTitle`, `contactMessagePath`, `contactMessageImg`,
  `showMessageCard`: optional mini program customer service message card fields.
- `serviceCorpId`, `serviceUrl`: required by `targetType: "serviceChat"` to
  open WeChat/WeCom customer service through `wx.openCustomerServiceChat`.
- `wechatId` or `targetWechat`: copied to clipboard by
  `targetType: "copyWechat"`. Mini programs cannot directly open an arbitrary
  personal WeChat account; use `contact`/`serviceChat` for official customer
  service, or `copyWechat` as the personal-WeChat fallback.
- `weight`: positive number for weighted random selection. Default `1`.
- `priority`: number used to sort candidate ads before weighted selection.
- `startAtMs`, `endAtMs`: optional millisecond timestamps for schedule windows.
- `createTime`, `updateTime`: server dates.

Ad image storage paths:

- `market_ad/`: main creative images.
- `market_ad_thumb/`: optional smaller creative images.

Optional file library collection:

- `MarketAdFiles`: reserve this collection if an admin uploader is added later.
  Suggested fields are `fileID`, `adId`, `type`, `folder`, `status`,
  `_openid`, `createdAt`, `updatedAt`, `createdAtMs`, and `updatedAtMs`.

Click analytics:

- `market_ad_events` receives one document for each click through `marketApi`
  action `trackAdClick`.
- It stores `adId`, `type: "click"`, `placement`, `listingType`, `_openid`,
  `createTime`, and `createTimeMs`.

Recommended indexes:

- `market_ads`: `status ASC, priority DESC, updateTime DESC`.
- `market_ad_events`: `adId ASC, type ASC, createTimeMs DESC`.
- `market_ad_events`: `_openid ASC, createTimeMs DESC`.

Example ad document:

```json
{
  "status": "online",
  "placement": "market_feed",
  "title": "校园搬家优惠",
  "badgeText": "广告",
  "ctaText": "查看",
  "imageFileID": "cloud://env-id.xxx/market_ad/example.jpg",
  "targetType": "contact",
  "contactSessionFrom": "market_ad_moving",
  "contactMessageTitle": "校园搬家优惠",
  "contactMessagePath": "/pages/market/market",
  "showMessageCard": true,
  "weight": 1,
  "priority": 10,
  "createTime": "serverDate",
  "updateTime": "serverDate"
}
```

Personal WeChat fallback:

```json
{
  "status": "online",
  "placement": "market_feed",
  "title": "校园搬家优惠",
  "badgeText": "广告",
  "ctaText": "复制微信",
  "imageFileID": "cloud://env-id.xxx/market_ad/example.jpg",
  "targetType": "copyWechat",
  "wechatId": "hotcatplus",
  "weight": 1
}
```
