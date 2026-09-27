/** Internal SQL alias only; never pass request input. The current reference is
 * the sole avatar fact, and an unavailable file never becomes a display ID. */
export function avatarFileIdSql(userAlias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(userAlias)) throw new Error('Invalid internal user alias');
  return `(SELECT avatar.file_id FROM file_references avatar
    JOIN files avatar_file ON avatar_file.app_id=avatar.app_id AND avatar_file.id=avatar.file_id AND avatar_file.status='ready'
    WHERE avatar.app_id=${userAlias}.app_id AND avatar.resource_kind='user'
      AND avatar.resource_id=${userAlias}.id::text AND avatar.slot='avatar')`;
}
