import { stableFileId, type FileReferenceRow, type FileRow } from './files.ts';
import { legacyCloudFileIdSchema } from './market-images.ts';
import type { Document, IssueReporter, UserRow } from './types.ts';
import { indexMigrationUsers, object } from './values.ts';

// Audited legacy upload namespace for this app, not a client-supplied URL or a
// configurable download destination. New app/source namespaces need an audit.
const avatarAppId = 'wx8a8a389199aa2a0e';
const avatarPrefix = 'cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/userAvatar/';
export const legacyDefaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';
type Input = {
  users: readonly UserRow[]; sourceUsers: readonly Document[];
  files: readonly FileRow[]; references: readonly FileReferenceRow[];
};

/** Current canonical profile references only. A referenced file does not prove
 * upload ownership, binary validity or a timestamp. Original profile values
 * remain in migration_sources; empty/default avatars create no custom file.
 * Run after the other file converters, including for a core-only import. */
export function normalizeAvatarFiles(input: Input, appId: string, issue: IssueReporter): {
  files: FileRow[]; references: FileReferenceRow[];
} {
  let failed = false;
  const error = (code: string) => { failed = true; issue('userInfo', code, 'avatarUrl'); };
  const empty = () => ({ files: [] as FileRow[], references: [] as FileReferenceRow[] });
  const users = indexMigrationUsers(input.users, appId, (collection, code, field, severity) => {
    failed = true; issue(collection, code, field, severity);
  });
  const sources = new Map<string, Document[]>();
  for (const source of input.sourceUsers) {
    // Alias/unattributed documents are handled and archived by normalizeUsers;
    // they cannot establish a profile or a second current avatar here.
    if (typeof source._openid !== 'string' || !users.has(source._openid)) continue;
    const matching = sources.get(source._openid) ?? [];
    matching.push(source); sources.set(source._openid, matching);
  }
  const files = new Map<string, FileRow>();
  const byId = new Map<string, FileRow>();
  for (const file of input.files) {
    if (!object(file) || file.appId !== appId || file.provider !== 'cloudbase' ||
      !legacyCloudFileIdSchema.safeParse(file.locator).success || file.id !== stableFileId(appId, file.locator) ||
      file.legacyReadonly !== true || !['pending', 'ready'].includes(file.status) ||
      files.has(file.locator) || byId.has(file.id)) {
      error('CONFLICTING_AVATAR_FILE_MAPPING'); continue;
    }
    // Existing market/content provenance is authoritative for this exact
    // locator. Do not replace its owner, clocks, status or metadata with guesses.
    files.set(file.locator, { ...file }); byId.set(file.id, file);
  }
  const references: FileReferenceRow[] = [];
  const slots = new Set<string>();
  const addReference = (reference: FileReferenceRow) => {
    const key = JSON.stringify([reference.resourceKind, reference.resourceId, reference.slot]);
    if (slots.has(key)) { error('CONFLICTING_AVATAR_FILE_REFERENCE'); return; }
    slots.add(key); references.push({ ...reference });
  };
  for (const reference of input.references) {
    if (reference.appId !== appId || reference.resourceKind === 'user' || !byId.has(reference.fileId) ||
      byId.get(reference.fileId)!.status !== 'ready') {
      error('CONFLICTING_AVATAR_FILE_REFERENCE'); continue;
    }
    addReference(reference);
  }
  for (const [openid, user] of users) {
    const canonical = sources.get(openid);
    if (canonical?.length !== 1) { error('UNRESOLVED_AVATAR_SOURCE'); continue; }
    const avatar = canonical[0]!.avatarUrl;
    if (avatar === undefined || avatar === '' || avatar === legacyDefaultAvatarUrl) continue;
    if (typeof avatar !== 'string' || appId !== avatarAppId || !avatar.startsWith(avatarPrefix) ||
      !legacyCloudFileIdSchema.safeParse(avatar).success || Buffer.byteLength(avatar, 'utf8') > 1024 ||
      avatar.includes('%') || avatar.slice(avatarPrefix.length).split('/').some(part => !part || part === '.' || part === '..')) {
      error('UNSUPPORTED_AVATAR_SOURCE'); continue;
    }
    let file = files.get(avatar);
    if (!file) {
      file = { id: stableFileId(appId, avatar), appId, provider: 'cloudbase', locator: avatar,
        ownerUserId: null, adminOwnerKey: null, uploadedByAdminId: null, legacyReadonly: true, status: 'ready',
        sizeBytes: null, mediaType: null, sha256: null, verifiedAt: null, createdAt: null, updatedAt: null };
      files.set(avatar, file); byId.set(file.id, file);
      issue('userInfo', 'AVATAR_FILE_UNKNOWN_PROVENANCE', 'avatarUrl', 'notice');
    }
    if (file.status !== 'ready') { error('AVATAR_FILE_PENDING_REFERENCED'); continue; }
    addReference({ appId, resourceKind: 'user', resourceId: user.id, slot: 'avatar', fileId: file.id });
  }
  return failed ? empty() : { files: [...files.values()], references };
}
