import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { APPID, PURPOSE, NOTICE, ENDPOINT, deriveSubject, parseInput, readPrivateFile, readStdin,
  sendLocal, stopCollection } from './stop-collection.mjs';

const openid = 'synthetic_account_openid_123';
const keys = () => ({ subjectKey: randomBytes(32), bridgeKey: randomBytes(32) });
const state = (status, statusVersion) => ({ ok: true, status, statusVersion, purposeVersion: PURPOSE,
  noticeVersion: NOTICE, ...(status === 'none' ? {} : { participantKey: 'synthetic_participant_key' }) });
function wire(reply, statusCode = 200, check = () => {}) {
  let calls = 0; let destroyed = 0;
  return { get calls() { return calls; }, get destroyed() { return destroyed; },
    request(url, options, callback) {
      calls++; const req = new EventEmitter();
      req.destroy = () => { destroyed++; req.emit('error', new Error('private transport detail')); };
      req.end = body => {
        check(url, options, body);
        if (reply === undefined) return;
        queueMicrotask(() => {
          const response = new EventEmitter(); response.statusCode = statusCode; callback(response);
          response.emit('data', Buffer.from(typeof reply === 'string' ? reply : JSON.stringify(reply)));
          response.emit('end');
        });
      };
      return req;
    },
  };
}

test('safe import has no root check, stdin read, secret read or network side effect', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('./stop-collection.mjs', import.meta.url).href)}); process.stdout.write('imported')`], { timeout: 2000 });
  assert.equal(output.toString(), 'imported');
});

test('identity JSON has exactly one bounded field and pseudonym uses the cloud scope', () => {
  assert.equal(parseInput(Buffer.from(JSON.stringify({ openid }))), openid);
  for (const raw of [Buffer.from(''), Buffer.from('{'), Buffer.from('[]'), Buffer.from('{"openid":1}'),
    Buffer.from(JSON.stringify({ openid, appid: APPID })),
    Buffer.from(`{"openid":"${openid}","openid":"another_account_123"}`), Buffer.alloc(4097)]) assert.throws(() => parseInput(raw));
  const key = randomBytes(32);
  assert.equal(deriveSubject(openid, key), createHmac('sha256', key)
    .update(`linkx-research-account-v1\n${APPID}\n${openid}`).digest('hex'));
});

test('input files require private ownership/mode and reject symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stop-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'input.json'); const raw = Buffer.from(JSON.stringify({ openid }));
  writeFileSync(path, raw, { mode: 0o600 });
  assert.deepEqual(readPrivateFile(path, 4096, process.getuid()), raw);
  assert.throws(() => readPrivateFile(path, 4096, process.getuid() + 1));
  chmodSync(path, 0o644); assert.throws(() => readPrivateFile(path, 4096, process.getuid()));
  chmodSync(path, 0o600); symlinkSync(path, join(dir, 'link'));
  assert.throws(() => readPrivateFile(join(dir, 'link'), 4096, process.getuid()));
});

test('active and unknown accounts receive one CAS withdrawal, never activation or raw identity', async () => {
  for (const [status, currentVersion] of [['active', 4], ['none', 0]]) {
    const requests = []; const secret = keys();
    const result = await stopCollection({ openid, ...secret, transport: async body => {
      requests.push(body); return requests.length === 1 ? state(status, currentVersion) : state('revoked', currentVersion + 1);
    } });
    assert.deepEqual(result, { ok: true, status: 'revoked', alreadyClosed: false });
    assert.deepEqual(requests.map(r => r.action), ['status', 'withdraw']);
    assert.equal(requests[1].expectedStatusVersion, currentVersion);
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.equal(requests[0].accountSubject, deriveSubject(openid, secret.subjectKey));
    assert.equal(JSON.stringify(requests).includes(openid), false);
    assert.deepEqual(Object.keys(result).sort(), ['alreadyClosed', 'ok', 'status']);
  }
});

test('already revoked is a read-only success; malformed replies and new participant IDs fail closed', async () => {
  let calls = 0;
  assert.deepEqual(await stopCollection({ openid, ...keys(), transport: async () => { calls++; return state('revoked', 3); } }),
    { ok: true, status: 'revoked', alreadyClosed: true });
  assert.equal(calls, 1);
  for (const bad of [state('none', 1), { ...state('active', 1), participantKey: undefined },
    { ...state('active', 1), noticeVersion: 'other' }, { ok: false, raw: openid }]) {
    calls = 0;
    const result = await stopCollection({ openid, ...keys(), transport: async () => { calls++; return bad; } });
    assert.deepEqual(result, { ok: false, status: 'unknown', error: 'INVALID_RESPONSE' }); assert.equal(calls, 1);
  }
  calls = 0;
  const result = await stopCollection({ openid, ...keys(), transport: async () => ++calls === 1 ? state('active', 1) :
    { ...state('revoked', 2), participantKey: 'another_participant_key' } });
  assert.equal(result.error, 'INVALID_RESPONSE'); assert.equal(calls, 2);
});

test('wire format matches the fixed loopback HMAC protocol and does not expose response session', async () => {
  const key = randomBytes(32); const body = { action: 'status', requestId: 'synthetic_request_id' };
  const nonce = 'a'.repeat(32); const now = 1800000000000;
  const mock = wire(state('none', 0), 200, (url, options, raw) => {
    assert.equal(url, ENDPOINT); assert.equal(options.method, 'POST'); assert.equal(options.agent, false);
    assert.equal(options.headers['X-Linkx-Timestamp'], String(now));
    assert.equal(options.headers['X-Linkx-Nonce'], nonce);
    assert.equal(options.headers['X-Linkx-Signature'], createHmac('sha256', key).update(`${now}\n${nonce}\n${raw}`).digest('hex'));
  });
  assert.deepEqual(await sendLocal(body, key, { request: mock.request, now: () => now, nonce: () => nonce }), state('none', 0));
  assert.equal(mock.calls, 1);
  assert.throws(() => sendLocal({ action: 'activate' }, key), /INVALID_REQUEST/);
});

test('CAS conflict never retries, redirects and sensitive upstream errors are reduced to safe results', async () => {
  const secret = keys(); let calls = 0;
  const conflict = wire({ ok: false, error: 'STATE_CONFLICT', privateDetail: openid }, 409);
  const result = await stopCollection({ openid, ...secret, transport: async (body, key) => {
    calls++; if (calls === 1) return state('active', 1);
    return sendLocal(body, key, { request: conflict.request });
  } });
  assert.deepEqual(result, { ok: false, status: 'unknown', error: 'STATE_CONFLICT' }); assert.equal(calls, 2);
  for (const [reply, code] of [[{ privateDetail: openid }, 302], [{ ok: false, error: openid }, 500], ['x'.repeat(8193), 200]]) {
    const mock = wire(reply, code);
    const failed = await stopCollection({ openid, ...secret, transport: (body, key) => sendLocal(body, key, { request: mock.request }) });
    assert.equal(failed.error, 'BRIDGE_UNAVAILABLE'); assert.equal(mock.calls, 1);
    assert.equal(JSON.stringify(failed).includes(openid), false);
  }
});

test('transport and stdin are bounded; failed keys cannot send a request', async () => {
  const mock = wire(undefined); const secret = keys();
  const result = await stopCollection({ openid, ...secret,
    transport: (body, key) => sendLocal(body, key, { request: mock.request, timeoutMs: 10 }) });
  assert.equal(result.error, 'BRIDGE_UNAVAILABLE'); assert.equal(mock.calls, 1); assert.equal(mock.destroyed, 1);
  const stream = new EventEmitter(); stream.pause = () => {};
  await assert.rejects(readStdin(stream, 10), /INVALID_INPUT/);
  const failed = await stopCollection({ openid, subjectKey: secret.bridgeKey, bridgeKey: secret.bridgeKey,
    transport: () => { throw new Error('must not send'); } });
  assert.equal(failed.error, 'KEY_UNAVAILABLE');
});
