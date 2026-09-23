import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseOptions, diagnoseAccount, sendAdmin, SOCKET_PATH } from './diagnose-account.mjs';
import { DIAGNOSTIC_ROUTE } from '../src/diagnostics.mjs';

const openid = 'operator_test_openid_123456';
const token = 'synthetic_admin_token_1234567890123456';
function none(body) { return { ok: true, synthetic: body.synthetic, status: 'none', account: null,
  coverage: { timeBasis: 'receivedAt', from: body.from, to: body.to, limit: body.limit, sampledAt: Date.now(),
    eventRetentionDays: body.synthetic ? 14 : 180, receiptRetentionDays: body.synthetic ? 30 : 187,
    retentionCutoff: Date.now() - (body.synthetic ? 14 : 180) * 86_400_000, windowStartsBeforeRetention: false,
    restoreGate: 'open', scope: 'retained_authorized_events', missingHistoryPossible: true },
  events: [], batches: [], hasMoreEvents: false, hasMoreBatches: false }; }

test('diagnostic CLI defaults real/24h/50 and rejects unknown, repeated and unbounded flags', () => {
  const now = Date.now(); assert.deepEqual(parseOptions([], now), { mode: 'real', from: now - 86_400_000, to: now, limit: 50 });
  assert.equal(parseOptions(['--mode','test','--limit','100']).mode, 'test');
  for (const args of [['--mode','both'], ['--openid',openid], ['--limit','101'], ['--limit','0'], ['--mode','test','--mode','real'],
    ['--from','0'], ['--limit']]) assert.throws(() => parseOptions(args));
});

test('operator tool sends direct OpenID only to fixed local read endpoint and strips unexpected response secrets', async () => {
  const range = { from: Date.now() - 1000, to: Date.now(), limit: 10 }; let calls = 0;
  for (const mode of ['real', 'test']) {
    const result = await diagnoseAccount({ openid, adminToken: token, mode, ...range, transport: async (body, key) => {
      calls++; assert.equal(body.openid, openid); assert.equal(body.accountSubject, undefined); assert.equal(key, token);
      assert.equal(body.synthetic, mode === 'test'); return { ...none(body), token, subjectKey: 'hidden' };
    } });
    assert.equal(result.ok, true); assert.equal(JSON.stringify(result).includes(token), false); assert.equal(result.subjectKey, undefined);
  }
  assert.equal(calls, 2);
  const mismatch = await diagnoseAccount({ openid, adminToken: token, ...range, transport: async body => ({ ...none(body), synthetic: true }) });
  assert.equal(mismatch.error, 'INVALID_DIAGNOSTIC_RESPONSE');
  const failure = await diagnoseAccount({ openid, adminToken: token, ...range, transport: async () => { throw Error(token); } });
  assert.deepEqual(failure, { ok: false, error: 'OPERATION_FAILED' });
});

test('UNIX transport never chooses a network host, mutation path or follows redirects', async () => {
  const body = { openid, synthetic: false, from: Date.now() - 1000, to: Date.now(), limit: 1 };
  const request = status => (options, callback) => {
    assert.equal(options.socketPath, SOCKET_PATH); assert.equal(options.host, undefined); assert.equal(options.path, DIAGNOSTIC_ROUTE);
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, `Bearer ${token}`);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = raw => {
      assert.deepEqual(JSON.parse(raw), body);
      queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = status; callback(res);
        res.emit('data', Buffer.from(JSON.stringify(none(body)))); res.emit('end'); });
    }; return req;
  };
  assert.equal((await sendAdmin(body, token, { request: request(200) })).ok, true);
  await assert.rejects(sendAdmin(body, token, { request: request(302) }), /ADMIN_UNAVAILABLE/);
});
