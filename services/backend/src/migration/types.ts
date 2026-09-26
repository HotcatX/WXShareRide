import type { MigrationSource } from './source.ts';
import type { TemplateRow } from './templates.ts';
import type { NotificationRow } from './notifications.ts';
import type { BlockRow } from './blocks.ts';
import type { RatingRow } from './ratings.ts';
import type { CompletionRow } from './completions.ts';
import type { PublicStatisticsRow } from './public-statistics.ts';
import type { ReferralCodeRow } from './referrals.ts';
import type { AdminAccountRow, AdminOriginRow } from './admin.ts';
import type { MarketListingRow } from './market.ts';
import type { FileRow, FileReferenceRow } from './files.ts';
import type { MarketViewRow } from './market-views.ts';
import type { AdRow, AdClickRow } from './ads.ts';
import type { CommunityRow, CommunityRevisionRow } from './community.ts';
import type { AdminAuditRow } from './admin-audit.ts';

export type Document = Record<string, unknown>;
export type Collection = 'userInfo' | 'Carpool' | 'CarpoolRequest' | 'other';
export type MigrationIssue = {
  collection: Collection; code: string; field: string; severity: 'error' | 'notice'; count: number;
};
export type UserRow = { id: string; appId: string; openid: string; name: string; avatarUrl: string; profile: Document; createdAt: string; updatedAt: string | null };
export type RideRow = { id: string; kind: 'offer' | 'request'; creatorId: string; cityKey: string | null; status: 'open' | 'cancelled' | 'closed'; seatCapacity: number | null; departureAt: string; timeZone: string; listedPriceCents: number | null; listedPriceLabel: string | null; details: Document; version: number; createdAt: string; updatedAt: string | null };
export type MemberRow = { rideId: string; userId: string; role: 'driver' | 'passenger'; seatCount: number; state: 'active'; joinedAt: string | null; leftAt: null; details: Document };
export type StopRow = { rideId: string; position: number; kind: 'departure' | 'destination'; address: string; placeId: string | null; departureAt: string | null };
export type ExportObservation = { sourceSha256: string; at: string };
export type MigrationRows = {
  users: UserRow[]; rides: RideRow[]; members: MemberRow[]; stops: StopRow[];
  templates: TemplateRow[]; notifications: NotificationRow[]; blocks: BlockRow[];
  ratings: RatingRow[]; completions: CompletionRow[]; publicStatistics: PublicStatisticsRow[]; referralCodes: ReferralCodeRow[];
  adminAccounts: AdminAccountRow[]; adminOrigins: AdminOriginRow[]; adminAudit: AdminAuditRow[];
  listings: MarketListingRow[]; files: FileRow[]; fileReferences: FileReferenceRow[]; marketViews: MarketViewRow[];
  ads: AdRow[]; adClicks: AdClickRow[]; communityConfigs: CommunityRow[]; communityRevisions: CommunityRevisionRow[];
};
export type MigrationPlan = MigrationRows & { sourceSha256: string; observedBefore: string | null; sources: MigrationSource[] };
export type MigrationReport = {
  sourceKind: 'cloudbase-full-export' | 'rejected'; ready: boolean;
  inputCounts: Record<Collection, number>; candidateCounts: { [K in keyof MigrationRows]: number };
  issues: MigrationIssue[];
};
export type CloudBaseExport = { kind: 'cloudbase-full-export'; appId: string; collections: Record<string, unknown[]> };

export type IssueReporter = (collection: Collection, code: string, field?: string, severity?: 'error' | 'notice') => void;
