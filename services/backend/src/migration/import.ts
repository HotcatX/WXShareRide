import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { normalizeCloudBaseExport } from './normalize.ts';
import type { ExportObservation, MigrationPlan, MigrationReport } from './types.ts';
import { serializeSource, sourceHash } from './source.ts';
import { object, text } from './values.ts';
import { schemaLockName } from './apply.ts';

const requiredCollections = ['userInfo', 'Carpool', 'CarpoolRequest', 'CarpoolTemplate', 'Notifications', 'UserBlocks', 'TripRatings', 'PublicStats'];
type Receipt = { batchId: string; sourceSha256: string; counts: MigrationReport['candidateCounts'] };

export class ImportAuditError extends AppError {
  readonly report: MigrationReport;
  constructor(report: MigrationReport) {
    super(400, 'IMPORT_AUDIT_FAILED', '导入数据未通过完整性校验');
    this.report = report;
  }
}

/** Fixed identifiers from source code only; values are always bound parameters. */
async function insertRows(client: PoolClient, table: string, columns: string[], rows: unknown[][]) {
  const size = 200;
  for (let offset = 0; offset < rows.length; offset += size) {
    const chunk = rows.slice(offset, offset + size);
    const values = chunk.flat();
    const tuples = chunk.map((_row, index) => `(${columns.map((_column, field) => `$${index * columns.length + field + 1}`).join(',')})`);
    await client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}

/**
 * Internal bootstrap for an empty, separately configured target database.
 * Not an HTTP endpoint, incremental sync, merge, reset or production cutover.
 * Re-normalize the original snapshot: never accept a caller-crafted plan.
 */
export async function importSnapshot(pool: Pool, source: unknown, expectedAppId: string, observation?: ExportObservation): Promise<Receipt> {
  try { serializeSource(source); } catch { throw new AppError(400, 'INVALID_IMPORT_SOURCE', '导入来源不是完整 JSON'); }
  if (!text(expectedAppId) || expectedAppId !== expectedAppId.trim() || !object(source) || source.appId !== expectedAppId) {
    throw new AppError(400, 'IMPORT_APP_MISMATCH', '导入来源与目标应用不一致');
  }
  const collections = source.collections;
  if (!object(collections) || requiredCollections.some(name => !Array.isArray(collections[name]))) {
    throw new AppError(400, 'INCOMPLETE_IMPORT_SOURCE', '缺少必需业务集合');
  }
  const normalized = normalizeCloudBaseExport(source, { timeZone: 'America/New_York', observation });
  if (!normalized.plan) throw new ImportAuditError(normalized.report);
  // Detach every nested value before the first await, so source mutation by a
  // caller cannot change the data after its conversion fingerprint is made.
  const planJson = serializeSource(normalized.plan);
  const plan: MigrationPlan = JSON.parse(planJson);
  const planSha256 = sourceHash(planJson);
  const counts = normalized.report.candidateCounts;
  return transaction(pool, async client => {
    // Share the schema runner's lock before discovering tables. A newly added
    // domain must never bypass empty-target protection because a list got stale.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schemaLockName]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('linkx-business-import',0))");
    const tables = (await client.query<{ qualified_name: string }>(
      `SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS qualified_name
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') AND c.relname <> 'schema_migrations'
       ORDER BY c.relname`
    )).rows.map(row => row.qualified_name);
    if (!tables.length) throw new AppError(409, 'IMPORT_SCHEMA_MISSING', '请先初始化目标数据库结构');
    // Prevent concurrent runtime writes throughout the empty-target check and
    // bootstrap. Identifiers below are quoted by PostgreSQL, never source data.
    // This dedicated application schema must not contain unrelated data tables.
    await client.query(`LOCK TABLE ${tables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    if (plan.observedBefore && (await client.query(
      'SELECT $1::timestamptz > clock_timestamp() AS future', [plan.observedBefore],
    )).rows[0].future) {
      throw new AppError(400, 'INVALID_EXPORT_OBSERVATION', '导出观测时间不能晚于数据库当前时间');
    }
    const existing = (await client.query(`SELECT id,plan_sha256,imported_counts FROM migration_batches
      WHERE app_id=$1 AND source_sha256=$2`, [expectedAppId, plan.sourceSha256])).rows[0];
    if (existing) {
      if (existing.plan_sha256 !== planSha256 || !existing.imported_counts) {
        throw new AppError(409, 'IMPORT_PLAN_CHANGED', '该来源的导入方案已变化，需要显式迁移');
      }
      return { batchId: existing.id, sourceSha256: plan.sourceSha256, counts: existing.imported_counts };
    }
    for (const table of tables) {
      if ((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount) throw new AppError(409, 'IMPORT_TARGET_NOT_EMPTY', '目标已有数据，不能执行首次导入');
    }
    const batchId = (await client.query(`INSERT INTO migration_batches(app_id,source_sha256,plan_sha256,imported_counts,observed_before)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [expectedAppId, plan.sourceSha256, planSha256, counts, plan.observedBefore])).rows[0].id as string;
    await insertRows(client, 'users', ['id','app_id','openid','name','avatar_url','profile','created_at','updated_at'],
      plan.users.map(row => [row.id,row.appId,row.openid,row.name,row.avatarUrl,row.profile,row.createdAt,row.updatedAt]));
    await insertRows(client, 'referral_codes', ['user_id','code'], plan.referralCodes.map(row => [row.userId,row.code]));
    await insertRows(client, 'rides', ['id','kind','creator_id','city_key','status','seat_capacity','departure_at','time_zone','listed_price_cents','listed_price_label','details','version','created_at','updated_at'],
      plan.rides.map(row => [row.id,row.kind,row.creatorId,row.cityKey,row.status,row.seatCapacity,row.departureAt,row.timeZone,row.listedPriceCents,row.listedPriceLabel,row.details,row.version,row.createdAt,row.updatedAt]));
    await insertRows(client, 'ride_stops', ['ride_id','position','kind','address','place_id','departure_at'],
      plan.stops.map(row => [row.rideId,row.position,row.kind,row.address,row.placeId,row.departureAt]));
    await insertRows(client, 'ride_members', ['ride_id','user_id','role','seat_count','state','joined_at','left_at','details'],
      plan.members.map(row => [row.rideId,row.userId,row.role,row.seatCount,row.state,row.joinedAt,row.leftAt,row.details]));
    await insertRows(client, 'ride_templates', ['id','user_id','name','weekday','local_time','time_zone','definition','created_at','updated_at'],
      plan.templates.map(row => [row.id,row.userId,row.name,row.weekday,row.localTime,row.timeZone,row.definition,row.createdAt,row.updatedAt]));
    await insertRows(client, 'user_blocks', ['blocker_id','target_id','active','reason','blocked_at','updated_at'],
      plan.blocks.map(row => [row.blockerId,row.targetId,row.active,row.reason,row.blockedAt,row.updatedAt]));
    await insertRows(client, 'notifications', ['id','user_id','event_id','ride_id','type','title','content','read','created_at'],
      plan.notifications.map(row => [row.id,row.userId,row.eventId,row.rideId,row.type,row.title,row.content,row.read,row.createdAt]));
    await insertRows(client, 'ride_ratings', ['id','ride_id','rater_id','target_id','rater_role','target_role','score','created_at','event_id'],
      plan.ratings.map(row => [row.id,row.rideId,row.raterId,row.targetId,row.raterRole,row.targetRole,row.score,row.createdAt,row.eventId]));
    await insertRows(client, 'ride_completions', ['ride_id','user_id','role','counted_at','event_id'],
      plan.completions.map(row => [row.rideId,row.userId,row.role,row.countedAt,row.eventId]));
    await insertRows(client, 'public_statistics', ['app_id','served_count','coverage_text','updated_at'],
      plan.publicStatistics.map(row => [row.appId,row.servedCount,row.coverageText,row.updatedAt]));
    await insertRows(client, 'admin_accounts', ['app_id','id','owner_key','enabled','credential_version','password_salt','password_hash','created_at','updated_at'],
      plan.adminAccounts.map(row => [row.appId,row.id,row.ownerKey,row.enabled,row.credentialVersion,
        Buffer.from(row.passwordSalt, 'hex'),Buffer.from(row.passwordHash, 'hex'),row.createdAt,row.updatedAt]));
    await insertRows(client, 'admin_origins', ['app_id','origin'], plan.adminOrigins.map(row => [row.appId,row.origin]));
    await insertRows(client, 'admin_audit', ['id','app_id','account_id','action','details','created_at'],
      plan.adminAudit.map(row => [row.id,row.appId,row.accountId,row.action,row.details,row.createdAt]));
    await insertRows(client, 'admin_requests', ['app_id','owner_key','operation','request_key','payload_hash','payload_format','response_status','response_body','created_at'],
      plan.adminRequests.map(row => [row.appId,row.ownerKey,row.operation,row.requestKey,row.payloadHash,row.payloadFormat,row.responseStatus,row.responseBody,row.createdAt]));
    await insertRows(client, 'market_import_batches', ['app_id','owner_key','id','payload_hash','payload_format','total','status','results','failures','created_at','updated_at'],
      plan.adminMarketBatches.map(row => [row.appId,row.ownerKey,row.id,row.payloadHash,row.payloadFormat,row.total,row.status,
        JSON.stringify(row.results),JSON.stringify(row.failures),row.createdAt,row.updatedAt]));
    await insertRows(client, 'market_templates', ['app_id','id','name','data','status','created_by_admin_id','updated_by_admin_id','created_at','updated_at'],
      plan.marketTemplates.map(row => [row.appId,row.id,row.name,row.data,row.status,row.createdByAdminId,row.updatedByAdminId,row.createdAt,row.updatedAt]));
    await insertRows(client, 'market_listings', ['app_id','id','owner_user_id','admin_owner_key','shared_admin_management','status','expires_at','version','content','created_at','updated_at'],
      plan.listings.map(row => {
        const { appId,id,ownerUserId,adminOwnerKey,sharedAdminManagement,status,expiresAt,version,createdAt,updatedAt,images: _images,...content } = row;
        return [appId,id,ownerUserId,adminOwnerKey,sharedAdminManagement,status,expiresAt,version,content,createdAt,updatedAt];
      }));
    await insertRows(client, 'files', ['id','app_id','provider','locator','owner_user_id','admin_owner_key','uploaded_by_admin_id','legacy_readonly','status','size_bytes','media_type','sha256','verified_at','created_at','updated_at'],
      plan.files.map(row => [row.id,row.appId,row.provider,row.locator,row.ownerUserId,row.adminOwnerKey,row.uploadedByAdminId,row.legacyReadonly,
        row.status,row.sizeBytes,row.mediaType,row.sha256,row.verifiedAt,row.createdAt,row.updatedAt]));
    await insertRows(client, 'file_references', ['app_id','resource_kind','resource_id','slot','file_id'],
      plan.fileReferences.map(row => [row.appId,row.resourceKind,row.resourceId,row.slot,row.fileId]));
    await insertRows(client, 'market_views', ['app_id','id','listing_id','actor_user_id','day','count','created_at','updated_at'],
      plan.marketViews.map(row => [row.appId,row.id,row.listingId,row.actorUserId,row.day,row.count,row.createdAt,row.updatedAt]));
    await insertRows(client, 'ads', ['app_id','id','status','placement','title','subtitle','badge_text','cta_text','weight','priority','start_at','end_at','target','created_at','updated_at'],
      plan.ads.map(row => [row.appId,row.id,row.status,row.placement,row.title,row.subtitle,row.badgeText,row.ctaText,row.weight,row.priority,
        row.startAt,row.endAt,row.target,row.createdAt,row.updatedAt]));
    await insertRows(client, 'ad_clicks', ['app_id','id','ad_id','placement','listing_type','actor_user_id','created_at'],
      plan.adClicks.map(row => [row.appId,row.id,row.adId,row.placement,row.listingType,row.actorUserId,row.createdAt]));
    await insertRows(client, 'community_configs', ['app_id','version','content','updated_by_admin_id','updated_at'],
      plan.communityConfigs.map(row => [row.appId,row.version,{ group: row.group, announcement: row.announcement },row.updatedByAdminId,row.updatedAt]));
    await insertRows(client, 'community_revisions', ['app_id','id','version','previous_version','before_content','after_content','updated_by_admin_id','updated_at'],
      plan.communityRevisions.map(row => [row.appId,row.id,row.version,row.previousVersion,row.before,row.after,row.updatedByAdminId,row.updatedAt]));
    await insertRows(client, 'migration_sources', ['batch_id','collection','source_id','document_json','sha256'],
      plan.sources.map(row => [batchId,row.collection,row.sourceId,row.documentJson,row.sha256]));
    // Read counts back inside the transaction, not from the intended input only.
    const modelTables = { users:'users', rides:'rides', members:'ride_members', stops:'ride_stops', templates:'ride_templates',
      notifications:'notifications', blocks:'user_blocks', ratings:'ride_ratings', completions:'ride_completions', publicStatistics:'public_statistics', referralCodes:'referral_codes',
      adminAccounts:'admin_accounts', adminOrigins:'admin_origins', adminAudit:'admin_audit', listings:'market_listings', files:'files', fileReferences:'file_references', marketViews:'market_views',
      adminMarketBatches:'market_import_batches', adminRequests:'admin_requests', marketTemplates:'market_templates',
      ads:'ads', adClicks:'ad_clicks', communityConfigs:'community_configs', communityRevisions:'community_revisions' } as const;
    for (const [name, table] of Object.entries(modelTables)) {
      const actual = (await client.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count;
      if (actual !== counts[name as keyof typeof modelTables]) throw new AppError(500, 'IMPORT_COUNT_MISMATCH', '导入数量核对失败');
    }
    const archived = (await client.query('SELECT count(*)::integer AS count FROM migration_sources WHERE batch_id=$1', [batchId])).rows[0].count;
    if (archived !== plan.sources.length) throw new AppError(500, 'IMPORT_COUNT_MISMATCH', '来源归档数量核对失败');
    return { batchId, sourceSha256: plan.sourceSha256, counts };
  });
}
