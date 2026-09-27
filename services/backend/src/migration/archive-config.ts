import { isDeepStrictEqual } from 'node:util';
import { getLocationCatalog } from '../locations/routes.ts';
import type { Document, IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

export const archivedConfigCollections = ['CITY_TREE', 'cityTree', 'regionTree', 'Departure', 'Arrival',
  'Departure_Request', 'Arrival_Request', 'Request_Price'] as const;
const catalog = getLocationCatalog();
const same = isDeepStrictEqual;
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();

/** Old configuration is source evidence, never another editable configuration
 * store. Only equality with the packaged single source, or its explicitly
 * expanded address directory, allows archival. No source value is discarded. */
export function validateArchivedConfig(name: string, rows: unknown[], issue: IssueReporter): void {
  const reject = () => issue('other', 'ARCHIVED_CONFIG_MISMATCH', name);
  let valid = rows.every(object);
  if (name === 'CITY_TREE') {
    const expected = catalog.regionTree.map(state => ({ _id: state.key,
      ...Object.fromEntries(state.groups.map(group => [group.key, group.areas])) }));
    const sorted = (values: Document[]) => [...values].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    // Region.js normalizes state identifiers to uppercase; keep the original
    // spelling in the archive rather than rewriting the source document.
    const normalized = valid ? (rows as Document[]).map(row => ({ ...row,
      _id: typeof row._id === 'string' ? row._id.toUpperCase() : row._id })) : [];
    valid = valid && same(sorted(normalized), sorted(expected));
  } else if (name === 'cityTree' || name === 'regionTree') {
    if (rows.length !== 1 || !object(rows[0])) valid = false;
    else {
      const { _id, version, updatedAt, ...content } = rows[0];
      valid = _id === 'default' && (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 || label(version)) &&
        !!parseExportTimestamp(updatedAt) && same(content, name === 'cityTree' ? catalog.cityTree : catalog.marketRegionTree);
    }
  } else if (name === 'Request_Price') {
    const prices = rows.map(row => {
      if (!object(row) || Object.keys(row).sort().join(',') !== 'Departure,Destination,Price,_id') { valid = false; return null; }
      return { fromAddress: row.Departure, toAddress: row.Destination, label: row.Price };
    });
    // Source order is not price precedence: every route pair is unique in the
    // canonical directory and the complete labels must agree exactly.
    const sorted = (values: unknown[]) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    valid = valid && same(sorted(prices), sorted(catalog.requestPrices));
  } else {
    if (rows.length !== 1 || !object(rows[0])) valid = false;
    else {
      const entries = Object.entries(rows[0]).filter(([key]) => key !== '_id');
      const request = name.endsWith('_Request');
      const target = catalog.rideAddresses[request ? 'request' : 'offer'][name.startsWith('Departure') ? 'fromPlaces' : 'toPlaces'];
      const identity = (value: string) => {
        // The old offer directory's airport label predates the explicit EWR
        // label. This exception is only configuration conversion, not a new
        // general classifier of Newark city addresses.
        if (!request && value === '纽瓦克') return 'ewr';
        return catalog.fixedPlaces.find(place => [place.value, place.label, ...place.aliases]
          .some(alias => compact(alias) === compact(value)))?.placeId;
      };
      valid = valid && entries.length > 0 && entries.length <= 100 &&
        new Set(entries.map(([, value]) => value)).size === entries.length && entries.every(([key, value]) =>
          label(key) && label(value) && (target.includes(value) || !!identity(value) && target.some(item => identity(item) === identity(value))));
    }
  }
  if (!valid) reject();
  else for (const _row of rows) issue('other', 'FIXED_CONFIG_SOURCE_ARCHIVED', name, 'notice');
}
