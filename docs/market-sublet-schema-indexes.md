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
- `postDate`: legacy display date.
- `pickupStartDate`, `pickupEndDate`, `pickupRangeText`, `expireTime`, `expiresAtText`: availability window.
- `imageFileID`, `thumbFileID`, `imageFileIDs`, `thumbFileIDs`, `hasImage`: storage references.
- `_openid`: publisher.

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

## Required Indexes

Create these composite indexes on `market_goods` for the current query shapes:

Status: created in `cloud1-7gmtcu4s3aebce27` on 2026-06-20 with CloudBase CLI.
`market_goods` went from 9 to 23 indexes. `MarketFiles` went from 5 to 7 indexes,
with one existing index reported by the CLI.

- `listingType ASC, status ASC, createTime DESC`
- `listingType ASC, status ASC, category ASC, createTime DESC`
- `listingType ASC, status ASC, region ASC, createTime DESC`
- `_openid ASC, listingType ASC, createTime DESC`
- `_openid ASC, listingType ASC, status ASC, createTime DESC`
- `_openid ASC, status ASC, createTime DESC`
- `_openid ASC, isSold ASC, createTime DESC`
- `_openid ASC, sold ASC, createTime DESC`
- `buyerOpenid ASC, isSold ASC, createTime DESC`
- `buyerOpenid ASC, sold ASC, createTime DESC`
- `buyerOpenid ASC, status ASC, createTime DESC`
- `buyer_openid ASC, isSold ASC, createTime DESC`
- `buyer_openid ASC, sold ASC, createTime DESC`
- `buyer_openid ASC, status ASC, createTime DESC`

Recommended indexes on `MarketFiles`:

- `fileID ASC, _openid ASC`
- `goodsId ASC, status ASC`
- `_openid ASC, status ASC, updatedAtMs DESC`

## Smoke Test Record

Use a short-lived test document and delete it after verification:

```json
{
  "listingType": "sublet",
  "title": "Codex test sublet",
  "price": 1200,
  "category": "单间",
  "roomType": "单间",
  "housingType": "公寓",
  "deposit": 1200,
  "furnished": true,
  "utilitiesIncluded": false,
  "genderPreference": "不限",
  "roommateCount": 2,
  "region": "Test / Test / Test",
  "desc": "Temporary sublet smoke test.",
  "status": "online"
}
```

The expected API behavior:

- `marketApi` `create` writes `listingType: "sublet"` and normalizes numbers/booleans.
- `marketApi` `list` with `filters.listingType: "sublet"` returns the record.
- `marketApi` `detail` returns `leaseText`, `depositText`, `subletMetaList`, and `/月` display helpers.
- `marketApi` `myList` and `sellerList` filter by `listingType`.
- `marketApi` `delete` removes the document and marks attached `MarketFiles` deleted.
