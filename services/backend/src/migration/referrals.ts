import type { IssueReporter, UserRow } from './types.ts';
import { indexMigrationUsers, object } from './values.ts';

export type ReferralCodeRow = { userId: string; code: string };

/** Preserve published codes exactly; a deterministic default is not permission to reissue them. */
export function normalizeReferralCodes(documents: unknown[], users: UserRow[], appId: string, issue: IssueReporter): ReferralCodeRow[] {
  const userMap = indexMigrationUsers(users, appId, issue);
  const owners = new Set<string>(), codes = new Set<string>();
  const rows: ReferralCodeRow[] = [];
  for (const raw of documents) {
    if (!object(raw) || raw.referralCode === undefined) continue;
    const user = typeof raw._openid === 'string' ? userMap.get(raw._openid) : undefined;
    if (!user) { issue('userInfo', 'UNVERIFIED_REFERRAL_IDENTITY', 'referralCode'); continue; }
    if (typeof raw.referralCode !== 'string' || raw.referralCode.length !== 16 || !/^ref_[a-f0-9]{12}$/.test(raw.referralCode)) {
      issue('userInfo', 'INVALID_REFERRAL_CODE', 'referralCode'); continue;
    }
    if (owners.has(user.id) || codes.has(raw.referralCode)) { issue('userInfo', 'DUPLICATE_REFERRAL_CODE', 'referralCode'); continue; }
    owners.add(user.id); codes.add(raw.referralCode);
    rows.push({ userId: user.id, code: raw.referralCode });
  }
  return rows;
}
