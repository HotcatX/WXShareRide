import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

process.umask(0o077);
const dir = resolve(process.env.SECRETS_DIR || './secrets');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const signing = join(dir, 'signing.pem'); const admin = join(dir, 'admin.token');
if (existsSync(signing) || existsSync(admin)) throw new Error('Refusing to overwrite existing key material');
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(signing, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
writeFileSync(admin, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write('Local key files created; no secrets printed.\n');
