import type { Pool } from 'pg';
import { AppError } from '../errors.ts';

export type Statistics = {
  completedTrips: number; ratingCount: number;
  averageRating: number | null; weightedRating: number | null;
};
export type UserStatistics = { all: Statistics; driver: Statistics; passenger: Statistics };
export type StatisticsFacts = { completedTrips: number; ratingCount: number; ratingSum: number };

// Only source-code call sites choose these expressions. No caller-provided ID,
// alias, role or SQL fragment is interpolated into a query.
const sources = {
  selfAll: { user: 'u.id', role: null },
  selfDriver: { user: 'u.id', role: "'driver'" },
  selfPassenger: { user: 'u.id', role: "'passenger'" },
  currentDriver: { user: 'statistics_driver.user_id', role: "'driver'" },
  currentParticipant: { user: 'm.user_id', role: 'm.role' },
} as const;

/** Private facts embedded in the caller's ONE authorized statement snapshot.
 * Always pass the returned facts through formatStatistics before serialization.
 * Receipts are historical facts: never filter them by today's membership state.
 */
export function statisticsProjection(source: keyof typeof sources): string {
  if (!Object.hasOwn(sources, source)) throw new Error('Unknown statistics projection');
  const { user, role } = sources[source];
  return `(SELECT jsonb_build_object('completedTrips', completed.count,
      'ratingCount', rated.count, 'ratingSum', rated.sum)
    FROM (SELECT count(*) AS count FROM ride_completions sc
      WHERE sc.user_id=${user}${role ? ` AND sc.role=${role}` : ''}) completed
    CROSS JOIN (SELECT count(*) AS count, COALESCE(sum(sr.score),0) AS sum FROM ride_ratings sr
      WHERE sr.target_id=${user}${role ? ` AND sr.target_role=${role}` : ''}) rated)`;
}

/** Preserve the existing JS toFixed rounding, including half-value boundaries. */
export function formatStatistics(facts: StatisticsFacts): Statistics {
  if (!facts || ![facts.completedTrips, facts.ratingCount, facts.ratingSum].every(value => Number.isSafeInteger(value) && value >= 0)
    || facts.ratingSum < facts.ratingCount || facts.ratingSum > facts.ratingCount * 5) {
    throw new AppError(503, 'STATISTICS_OUT_OF_RANGE', '统计数据暂不可用');
  }
  return {
    completedTrips: facts.completedTrips,
    ratingCount: facts.ratingCount,
    averageRating: facts.ratingCount ? Number((facts.ratingSum / facts.ratingCount).toFixed(1)) : null,
    weightedRating: facts.ratingCount ? Number(((facts.ratingSum + 4.7 * 3) / (facts.ratingCount + 3)).toFixed(1)) : null,
  };
}

/** All public and personal ride-list exits share this explicit sanitization. */
export function formatDriverStatistics<T extends { driverStatistics: StatisticsFacts | null }>(ride: T) {
  return { ...ride, driverStatistics: ride.driverStatistics === null ? null : formatStatistics(ride.driverStatistics) };
}

/** Internal use only: HTTP identity is obtained from requireUser, never a query ID. */
export async function userStatistics(pool: Pool, userId: string): Promise<UserStatistics> {
  const result = await pool.query<{ all: StatisticsFacts; driver: StatisticsFacts; passenger: StatisticsFacts }>(`
    SELECT ${statisticsProjection('selfAll')} AS all,
      ${statisticsProjection('selfDriver')} AS driver,
      ${statisticsProjection('selfPassenger')} AS passenger
    FROM users u WHERE u.id=$1`, [userId]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在');
  return { all: formatStatistics(row.all), driver: formatStatistics(row.driver), passenger: formatStatistics(row.passenger) };
}

export async function publicStatistics(pool: Pool, appId: string): Promise<{ servedCount: number; coverageText: string | null }> {
  // Read bigint as text and check its range before converting to a JSON number.
  const result = await pool.query<{ count: string; coverageText: string | null }>(`
    SELECT served_count::text AS count,coverage_text AS "coverageText" FROM public_statistics WHERE app_id=$1`, [appId]);
  if (!result.rowCount) throw new AppError(503, 'STATISTICS_NOT_INITIALIZED', '统计基线尚未初始化');
  const count = BigInt(result.rows[0]!.count);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(503, 'STATISTICS_OUT_OF_RANGE', '统计数据暂不可用');
  return { servedCount: Number(count), coverageText: result.rows[0]!.coverageText };
}
