import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { normalizeCloudBaseExport } from './normalize.ts';
import type { ExportObservation, MigrationPlan, MigrationReport } from './types.ts';
import { serializeSource, sourceHash } from './source.ts';
import { object, text } from './values.ts';

const requiredCollections = ['userInfo', 'Carpool', 'CarpoolRequest', 'CarpoolTemplate', 'Notifications', 'UserBlocks', 'TripRatings', 'PublicStats'];
const tables = ['users', 'sessions', 'rides', 'ride_stops', 'ride_members', 'ride_templates', 'user_blocks',
  'notifications', 'ride_ratings', 'ride_completions', 'public_statistics', 'business_events', 'idempotency_requests',
  'referral_codes', 'referral_bindings', 'migration_batches', 'migration_sources'];
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
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('linkx-business-import',0))");
    // Prevent concurrent runtime writes throughout the empty-target check and
    // bootstrap. The operation never deletes or merges existing business rows.
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
    await insertRows(client, 'migration_sources', ['batch_id','collection','source_id','document_json','sha256'],
      plan.sources.map(row => [batchId,row.collection,row.sourceId,row.documentJson,row.sha256]));
    // Read counts back inside the transaction, not from the intended input only.
    const modelTables = { users:'users', rides:'rides', members:'ride_members', stops:'ride_stops', templates:'ride_templates',
      notifications:'notifications', blocks:'user_blocks', ratings:'ride_ratings', completions:'ride_completions', publicStatistics:'public_statistics', referralCodes:'referral_codes' } as const;
    for (const [name, table] of Object.entries(modelTables)) {
      const actual = (await client.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count;
      if (actual !== counts[name as keyof typeof modelTables]) throw new AppError(500, 'IMPORT_COUNT_MISMATCH', '导入数量核对失败');
    }
    const archived = (await client.query('SELECT count(*)::integer AS count FROM migration_sources WHERE batch_id=$1', [batchId])).rows[0].count;
    if (archived !== plan.sources.length) throw new AppError(500, 'IMPORT_COUNT_MISMATCH', '来源归档数量核对失败');
    return { batchId, sourceSha256: plan.sourceSha256, counts };
  });
}
