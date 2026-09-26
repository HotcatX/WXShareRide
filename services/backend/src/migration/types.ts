import type { MigrationSource } from './source.ts';
import type { TemplateRow } from './templates.ts';
import type { NotificationRow } from './notifications.ts';
import type { BlockRow } from './blocks.ts';

export type Document = Record<string, unknown>;
export type Collection = 'userInfo' | 'Carpool' | 'CarpoolRequest' | 'other';
export type MigrationIssue = {
  collection: Collection; code: string; field: string; severity: 'error' | 'notice'; count: number;
};
export type UserRow = { id: string; appId: string; openid: string; name: string; avatarUrl: string; profile: Document; createdAt: string; updatedAt: string | null };
export type RideRow = { id: string; kind: 'offer' | 'request'; creatorId: string; cityKey: string | null; status: 'open' | 'cancelled' | 'closed'; seatCapacity: number | null; departureAt: string; timeZone: string; listedPriceCents: number | null; listedPriceLabel: string | null; details: Document; version: number; createdAt: string; updatedAt: string | null };
export type MemberRow = { rideId: string; userId: string; role: 'driver' | 'passenger'; seatCount: number; state: 'active'; joinedAt: string | null; leftAt: null; details: Document };
export type StopRow = { rideId: string; position: number; kind: 'departure' | 'destination'; address: string; placeId: string | null; departureAt: string | null };
export type MigrationPlan = { sourceSha256: string; sources: MigrationSource[]; users: UserRow[]; rides: RideRow[]; members: MemberRow[]; stops: StopRow[]; templates: TemplateRow[]; notifications: NotificationRow[]; blocks: BlockRow[] };
export type MigrationReport = {
  sourceKind: 'cloudbase-full-export' | 'rejected'; ready: boolean;
  inputCounts: Record<Collection, number>; candidateCounts: { users: number; rides: number; members: number; stops: number; templates: number; notifications: number; blocks: number };
  issues: MigrationIssue[];
};
export type CloudBaseExport = { kind: 'cloudbase-full-export'; appId: string; collections: Record<string, unknown[]> };

export type IssueReporter = (collection: Collection, code: string, field?: string, severity?: 'error' | 'notice') => void;
