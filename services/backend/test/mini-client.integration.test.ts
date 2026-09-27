import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import sharp from 'sharp';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';
import type { FileStorage } from '../src/files/routes.ts';

const require = createRequire(import.meta.url);
const { createBackendClient, PENDING_KEY } = require('../../../utils/backendClient.js');
const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-mini-sdk-user';

test('real mini transport crosses signed bridge, PostgreSQL receipts and binary images without duplicate writes after lost ACKs',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase(), bridgeKey = randomBytes(32);
    const objects = new Map<string, { body: Buffer; mediaType: string }>();
    let puts = 0;
    const storage: FileStorage = { bucket: 'synthetic-mini-images', objects: {
      async put(locator, body, mediaType) { puts++; objects.set(locator, { body: Buffer.from(body), mediaType }); },
      async read(locator) { return objects.get(locator) ?? null; },
    }, async readUrl(file, ttl) { assert.equal(ttl, 300); return `https://images.example.test/${file.id}?signed=synthetic`; } };
    const app = await createApp({ pool: db.pool, config: { databaseUrl: '', host: '127.0.0.1', port: 3100,
      appId, sessionTtlSeconds: 3600, businessMode: 'active', authBridgeKey: bridgeKey }, storage });
    t.after(async () => { await app.close(); await db.close(); });
    const local = new Map<string, any>([['openid', openid], ['isGuest', false]]);
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#457890' } }).png().toBuffer();
    let loseImageAck = true, loseProfileAck = true, bridgeCalls = 0;
    const requests: any[] = [];
    const wx = {
      getStorageSync: (key: string) => structuredClone(local.get(key)),
      setStorageSync: (key: string, value: unknown) => { local.set(key, structuredClone(value)); },
      removeStorageSync: (key: string) => { local.delete(key); },
      cloud: { async callFunction(value: any) {
        assert.deepEqual(value, { name: 'backend', data: { action: 'login' } }); bridgeCalls++;
        const body = Buffer.from(JSON.stringify({ purpose: 'login', appId, openid, source: 'wx_client' }));
        const at = String(Date.now()), nonce = randomBytes(16).toString('hex'), path = '/internal/v1/auth/cloudbase';
        const signature = createHmac('sha256', bridgeKey)
          .update(['linkx-auth-bridge-v1', 'POST', path, appId, at, nonce, ''].join('\n')).update(body).digest('hex');
        const result = await app.inject({ method: 'POST', url: path, payload: body, headers: {
          'content-type': 'application/json', 'x-linkx-auth-timestamp': at,
          'x-linkx-auth-nonce': nonce, 'x-linkx-auth-signature': signature,
        } });
        assert.equal(result.statusCode, 200, result.body);
        return { result: result.json() };
      } },
      request(options: any) {
        requests.push(options);
        const path = new URL(options.url).pathname;
        const payload = options.data instanceof ArrayBuffer ? Buffer.from(options.data) : options.data;
        void app.inject({ method: options.method, url: options.url.replace('https://collect.linkx.ink', ''),
          headers: options.header, ...(payload === undefined ? {} : { payload }) }).then(result => {
          if (result.statusCode < 300 && ((path === '/api/v1/files/images' && loseImageAck) || (options.method === 'PATCH' && loseProfileAck))) {
            if (path === '/api/v1/files/images') loseImageAck = false; else loseProfileAck = false;
            options.fail({ errMsg: 'synthetic lost ACK after commit' });
          } else options.success({ statusCode: result.statusCode, data: result.json() });
        }).catch(error => options.fail(error));
        return { abort() {} };
      },
      getFileSystemManager: () => ({ readFile(options: any) { options.success({ data: Uint8Array.from(image).buffer }); } }),
    };
    const factory = () => createBackendClient({ wx, config: { mode: 'server' } });
    let client = factory();
    const login = await client.login();
    assert.equal(login.user.openid, openid);
    assert.equal((await client.get('/api/v1/me')).id, login.user.id);
    assert.equal((await client.get('/api/v1/locations', { public: true })).fixedPlaces[0].placeId, 'fort_lee');
    await assert.rejects(client.uploadImage('/tmp/synthetic.png', 'profile.avatar'), { code: 'NETWORK_ERROR' });
    client = factory();
    const uploaded = await client.uploadImage('/tmp/synthetic.png', 'profile.avatar');
    assert.equal(puts, 1);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM files')).rows[0].n, 1);
    const patch = { name: 'First', avatarFileId: uploaded.fileId, profile: { bio: 'Original profile' } };
    await assert.rejects(client.mutate('profile.update', 'PATCH', '/api/v1/me', patch), { code: 'NETWORK_ERROR' });
    client = factory();
    await assert.rejects(client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'Latest' }), { code: 'PENDING_OPERATION' });
    assert.equal((await client.retryPending('profile.update')).name, 'First');
    assert.equal((await client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'Latest' })).avatarFileId, uploaded.fileId);
    const current = await client.get('/api/v1/me');
    assert.equal(current.name, 'Latest'); assert.equal(current.profile.bio, 'Original profile');
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM idempotency_requests WHERE operation='users.update'")).rows[0].n, 2);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM file_references WHERE resource_kind='user'")).rows[0].n, 1);
    const signed = await client.resolveImages([uploaded.fileId]);
    assert.equal(signed.length, 1); assert.equal(signed[0].fileId, uploaded.fileId);
    assert.equal((await client.get('/api/v1/referrals/me')).code, login.user.referralCode);
    assert.equal((await client.get('/api/v1/notifications/unread')).unreadCount, 0);
    assert.deepEqual((await client.get('/api/v1/me/rides?scope=history')).rides, []);
    assert.equal(local.has(PENDING_KEY), false); assert.equal(bridgeCalls, 1);
    const patches = requests.filter(req => req.method === 'PATCH');
    assert.equal(patches.length, 3);
    assert.equal(patches[0].header['Idempotency-Key'], patches[1].header['Idempotency-Key']);
    assert.notEqual(patches[1].header['Idempotency-Key'], patches[2].header['Idempotency-Key']);
    await client.logout();
    await assert.rejects(client.get('/api/v1/me'), { code: 'UNAUTHORIZED' });
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n, 0);
  });
