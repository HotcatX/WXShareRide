import { createPrivateKey, createPublicKey, sign, verify, timingSafeEqual, randomUUID } from 'node:crypto';
import { requireThat, ApiError } from './errors.mjs';
import { id, purpose, version, shape } from './validation.mjs';
import { TOKEN_ISSUER, TOKEN_AUDIENCE, canonicalPurposeVersion } from './protocol.mjs';
import { LEGACY_TOKEN_ISSUER, LEGACY_TOKEN_AUDIENCE } from './compat/legacy.mjs';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = value => {
  requireThat(/^[A-Za-z0-9_-]+$/.test(value), 401, 'INVALID_TOKEN');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
};

export function sameSecret(actual, expected) {
  const a = Buffer.from(actual || ''); const b = Buffer.from(expected || '');
  return a.length === b.length && b.length >= 32 && timingSafeEqual(a, b);
}

export function createTokenService(privatePem, { issuer = TOKEN_ISSUER, audience = TOKEN_AUDIENCE, keyId = 'local-v1', ttlSeconds = 900 } = {}) {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) throw new Error('Invalid token TTL');
  const publicKey = createPublicKey(privateKey);
  return {
    issue(participant, nowMs = Date.now()) {
      const now = Math.floor(nowMs / 1000);
      const claims = {
        iss: issuer, aud: audience, sub: participant.participantKey,
        grantId: participant.grantId, statusVersion: participant.statusVersion,
        purposeVersion: canonicalPurposeVersion(participant.purposeVersion), iat: now, exp: now + ttlSeconds, jti: randomUUID(),
        scopes: ['batches:write', 'places:read'],
      };
      const input = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: keyId })}.${encode(claims)}`;
      return { token: `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`, tokenExpiresAtMs: claims.exp * 1000 };
    },
    verify(token, nowMs = Date.now()) {
      try {
        requireThat(typeof token === 'string' && token.length <= 2048, 401, 'INVALID_TOKEN');
        const parts = token.split('.');
        requireThat(parts.length === 3, 401, 'INVALID_TOKEN');
        const header = decode(parts[0]);
        requireThat(shape(header, { alg: v => v === 'EdDSA', typ: v => v === 'JWT', kid: v => v === keyId }), 401, 'INVALID_TOKEN');
        requireThat(/^[A-Za-z0-9_-]+$/.test(parts[2])
          && verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url')), 401, 'INVALID_TOKEN');
        const claims = decode(parts[1]);
        const currentAudience = claims?.iss === issuer && claims?.aud === audience;
        const compatibleAudience = issuer === TOKEN_ISSUER && audience === TOKEN_AUDIENCE
          && claims?.iss === LEGACY_TOKEN_ISSUER && claims?.aud === LEGACY_TOKEN_AUDIENCE;
        requireThat(currentAudience || compatibleAudience, 401, 'INVALID_TOKEN');
        requireThat(shape(claims, {
          iss: v => typeof v === 'string', aud: v => typeof v === 'string', sub: id, grantId: id,
          statusVersion: version, purposeVersion: purpose, iat: Number.isSafeInteger,
          exp: Number.isSafeInteger, jti: id,
          scopes: v => Array.isArray(v) && v.length <= 2 && new Set(v).size === v.length
            && v.every(s => ['batches:write', 'places:read'].includes(s)),
        }, ['iss', 'aud', 'sub', 'grantId', 'statusVersion', 'purposeVersion', 'iat', 'exp', 'jti']), 401, 'INVALID_TOKEN');
        const now = Math.floor(nowMs / 1000);
        requireThat(claims.iat <= now + 30 && claims.exp > claims.iat && claims.exp - claims.iat <= ttlSeconds, 401, 'INVALID_TOKEN');
        requireThat(claims.exp > now, 401, 'TOKEN_EXPIRED');
        return { ...claims, purposeVersion: canonicalPurposeVersion(claims.purposeVersion) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(401, 'INVALID_TOKEN');
      }
    },
  };
}
