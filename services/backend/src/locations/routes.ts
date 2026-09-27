import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { marketStateSchema } from '../market/schemas.ts';

const text = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
  .refine(value => value.trim() === value && value.trim().length > 0);
const key = z.string().min(1).max(80);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const addressList = z.array(text).min(1).max(100).refine(unique);
const addresses = z.strictObject({ fromPlaces: addressList, toPlaces: addressList });
const city = z.strictObject({ key, label: text, aliases: z.array(text).max(100) });
const country = z.strictObject({ code: key, label: text, groups: z.array(z.strictObject({
  title: text, badge: text.optional(), cities: z.array(city).min(1).max(100),
})).min(1).max(30) });
const region = z.strictObject({ key, label: text, groups: z.array(z.strictObject({
  key, label: text, areas: z.array(text).min(1).max(100).refine(unique),
})).min(1).max(100) });
const marketArea = z.strictObject({ key, label: text, aliases: z.array(text).max(100),
  sectionKey: key.optional(), sectionLabel: text.optional(), groupKey: key.optional(), groupLabel: text.optional() });

export const locationCatalogSchema = z.strictObject({
  version: key, placeCatalogVersion: key,
  fixedPlaces: z.array(z.strictObject({ placeId: key, label: text, value: text,
    aliases: z.array(text).max(100), airport: z.boolean() })).min(1).max(100)
    .refine(places => unique(places.map(place => place.placeId))),
  rideAddresses: z.strictObject({ offer: addresses, request: addresses }),
  requestPrices: z.array(z.strictObject({ fromAddress: text, toAddress: text, label: z.string().min(1).max(1000) })).max(1000)
    .refine(rows => unique(rows.map(row => JSON.stringify([row.fromAddress, row.toAddress])))),
  cityTree: z.strictObject({ countries: z.array(country).min(1).max(30),
    defaultCityKey: key, defaultCityLabel: text, marketDefaultCityKey: key, marketDefaultCityLabel: text,
    rideDefaultCityKey: key, rideDefaultCityLabel: text }),
  regionTree: z.array(region).min(1).max(100).refine(regions => unique(regions.map(region => region.key))),
  marketRegionTree: z.strictObject({ states: z.array(z.strictObject({ key: marketStateSchema, label: text,
    areas: z.array(marketArea).min(1).max(100).refine(areas => unique(areas.map(area => area.key))),
  })).min(1).max(100).refine(states => unique(states.map(state => state.key))) }),
});

// Invalid or missing packaged configuration prevents startup, rather than
// treating an empty directory as a successful production response.
const catalog = locationCatalogSchema.parse(JSON.parse(readFileSync(new URL('./catalog.generated.json', import.meta.url), 'utf8')));
export function getLocationCatalog() { return structuredClone(catalog); }

export function registerLocationRoutes(app: FastifyInstance) {
  app.get('/api/v1/locations', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    reply.header('Cache-Control', 'public, max-age=300');
    reply.header('Access-Control-Allow-Origin', '*');
    return { ok: true, data: getLocationCatalog(), requestId: request.id };
  });
}
