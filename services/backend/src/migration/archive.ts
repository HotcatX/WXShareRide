import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Document, IssueReporter, UserRow } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';
import { archivedConfigCollections, validateArchivedConfig } from './archive-config.ts';
import { archivedAccessCollections, validateArchivedAccess } from './archive-access.ts';

export const archivedCollections = new Set<string>([...archivedConfigCollections, ...archivedAccessCollections,
  'TripActions', 'MyTrips', 'MyTripHistory', 'feedback', 'MarketAdFiles']);
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/);
const openid = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const time = z.custom<unknown>(value => !!parseExportTimestamp(value));
const text = z.string().max(4000);
const code = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
const role = z.enum(['driver', 'passenger']);
const kind = z.enum(['carpool', 'request']);
const integer = (maximum = Number.MAX_SAFE_INTEGER) => z.number().int().min(0).max(maximum);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const date = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const wireText = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f]*$/u);
const wirePlace = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/);
const endpoint = z.strictObject({ address: wireText(200), placeId: z.union([z.literal(''), wirePlace]),
  date: z.union([z.literal(''), date]), time: wireText(32) });
const edges = z.array(z.strictObject({ openid, role })).max(101).refine(values => unique(values.map(value => value.openid)));
const snapshot = z.strictObject({ cityKey: code, status: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  departures: z.array(endpoint).min(1).max(12), destinations: z.array(endpoint).min(1).max(12),
  referencePriceCents: integer(1_000_000).nullable(), currency: z.literal('USD'), priceKind: z.literal('listed_reference'),
  availableSeats: integer(20).nullable(), passengerCount: integer(100), creatorOpenid: openid,
  driverOpenid: z.union([z.literal(''), openid]), passengerOpenids: z.array(openid).max(100).refine(unique), participantEdges: edges,
  serviceDate: z.union([z.literal(''), date]), departureAtMs: integer().nullable(), latestDepartureAtMs: integer().nullable(),
  tripVersion: integer(2_147_483_647) });
// Frozen historical v1 contract, limited to rows the old transactional producer
// actually wrote. Tests also pass accepted rows to the real collector receiver.
// This does not change the running collector protocol or create replay events.
export const archivedBusinessEventSchema = z.strictObject({ schemaVersion: z.literal(1),
  eventId: z.string().regex(/^[a-f0-9]{64}$/), tripId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), tripType: kind,
  action: z.enum(['publish', 'join', 'accept', 'quit', 'kick', 'delete', 'status', 'update', 'cancel']),
  actorOpenid: z.union([z.literal(''), openid]), eventAtMs: integer(), version: integer(2_147_483_647).min(1),
  before: snapshot.nullable(), after: snapshot.nullable(), affectedOpenids: z.array(openid).max(101).refine(unique), synthetic: z.literal(false),
}).refine(event => !!(event.before || event.after) && (!event.after || event.after.tripVersion === event.version) &&
  (event.actorOpenid !== '' || event.action === 'status'));
const delivered = z.strictObject({ _id: id, type: kind, tripId: id, action: code, actorOpenid: z.union([z.literal(''), openid]),
  reason: z.string().max(180), createdAt: time, deliveredAt: time, deliveryState: z.literal('delivered'), event: archivedBusinessEventSchema });
const actionLog = z.strictObject({ _id: id, type: kind, tripId: z.union([z.literal(''), id]), action: code,
  actorOpenid: openid.optional(), _openid: openid.optional(), createdAt: time.optional(), createTime: time.optional(),
  reason: text.optional(), otherReason: text.optional(), reasonOption: text.optional(), source: code.optional(), requestId: id.optional(),
  targetOpenid: z.union([z.literal(''), openid]).optional(), targets: z.array(openid).max(1000).optional(),
  score: z.number().int().min(1).max(5).optional(), raterRole: role.optional(), targetRole: role.optional(),
}).refine(row => !!(row.actorOpenid || row._openid) && !!(row.createdAt || row.createTime) &&
  (!row.actorOpenid || !row._openid || row.actorOpenid === row._openid) &&
  (row.action !== 'rateUser' || row.score !== undefined && !!row.targetOpenid && !!row.raterRole && !!row.targetRole));
const oldPoint = z.strictObject({ address: text.min(1), date: z.string().optional(), time: z.string().optional() });
const oldSnapshot = z.strictObject({ tripId: id, createdAt: time, departures: z.array(oldPoint).min(1).max(100),
  destinations: z.array(oldPoint).min(1).max(100), role, status: code });
const oldHistoryFields = { _id: id, _openid: openid, userId: id, createdAt: time, updatedAt: time };
const oldTrips = z.strictObject({ ...oldHistoryFields, trips: z.array(oldSnapshot).max(10000) });
const oldHistory = z.strictObject({ ...oldHistoryFields, historyTrips: z.array(oldSnapshot).max(10000) });
const feedback = z.strictObject({ _id: id, _openid: openid, content: text.min(1), createTime: time,
  email: z.string().max(320), phone: z.string().max(100), region: z.string().max(200) });

/** Only validate explicitly retired/configuration sources. The central archive
 * already keeps their exact JSON+hash. Never create rides, memberships, ratings,
 * completions, or business_events from these snapshots or delivered logs. */
export function validateArchivedCollections(docs: Document, users: readonly UserRow[], issue: IssueReporter): void {
  const accounts = new Set(users.map(user => user.openid));
  const sourceUsers = new Map((Array.isArray(docs.userInfo) ? docs.userInfo : []).filter(object).map(row => [row._id, row]));
  for (const name of archivedCollections) {
    if (docs[name] === undefined) continue;
    const rows = docs[name];
    const reject = (code: string) => issue('other', code, name);
    if (!Array.isArray(rows)) { reject('INVALID_ARCHIVE_COLLECTION'); continue; }
    if ((archivedConfigCollections as readonly string[]).includes(name)) { validateArchivedConfig(name, rows, issue); continue; }
    if (archivedAccessCollections.includes(name)) { validateArchivedAccess(name, rows, issue); continue; }
    if (name === 'MarketAdFiles') {
      if (rows.length) reject('EXPECTED_EMPTY_COLLECTION');
      else issue('other', 'EMPTY_RESERVED_COLLECTION', name, 'notice');
      continue;
    }
    for (const row of rows) {
      if (name === 'TripActions') {
        if (object(row) && ['event', 'deliveryState', 'deliveredAt'].some(key => Object.hasOwn(row, key))) {
          if (row.deliveryState === 'pending') { reject('BUSINESS_OUTBOX_NOT_DRAINED'); continue; }
          const parsed = delivered.safeParse(row);
          if (!parsed.success) { reject('INVALID_ARCHIVED_BUSINESS_EVENT'); continue; }
          const value = parsed.data, event = value.event;
          const eventId = createHash('sha256').update(`ride-business-v1\n${event.tripType}\n${event.tripId}\n${event.version}`).digest('hex');
          if (value._id !== event.eventId || event.eventId !== eventId || value.type !== event.tripType || value.tripId !== event.tripId ||
            value.action !== event.action || value.actorOpenid !== event.actorOpenid ||
            parseExportTimestamp(value.deliveredAt)! < parseExportTimestamp(value.createdAt)!) { reject('INVALID_ARCHIVED_BUSINESS_EVENT'); continue; }
          issue('other', 'DELIVERED_BUSINESS_EVENT_ARCHIVED', name, 'notice');
        } else if (!actionLog.safeParse(row).success) reject('INVALID_ARCHIVED_ACTION_LOG');
        else issue('other', 'LEGACY_ACTION_LOG_ARCHIVED', name, 'notice');
      } else {
        const schema = name === 'feedback' ? feedback : name === 'MyTrips' ? oldTrips : oldHistory;
        const parsed = schema.safeParse(row);
        if (!parsed.success) { reject('INVALID_ARCHIVED_DOCUMENT'); continue; }
        if (!accounts.has(parsed.data._openid)) { reject('UNKNOWN_ARCHIVED_OWNER'); continue; }
        if (name !== 'feedback' && 'userId' in parsed.data) {
          const source = sourceUsers.get(parsed.data.userId);
          if (source && source._openid !== parsed.data._openid) { reject('CONFLICTING_ARCHIVED_OWNER'); continue; }
          if (!source) issue('other', 'ARCHIVED_USER_DOCUMENT_MISSING', name, 'notice');
        }
        issue('other', 'RETIRED_SOURCE_ARCHIVED', name, 'notice');
      }
    }
  }
}
