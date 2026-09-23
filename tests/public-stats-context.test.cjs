const test = require('node:test')
const assert = require('node:assert/strict')
const { getInvocationContext } = require('../cloudfunctions/statistics/timer-context')

test('modern current context exposes only source and caller identities', () => {
  assert.deepEqual(getInvocationContext({ environment: JSON.stringify({
    TCB_SOURCE: 'wx_client,scf', WX_OPENID: 'caller', WX_FROM_OPENID: 'external',
    TENCENTCLOUD_SECRETKEY: 'not-returned', WX_API_TOKEN: 'not-returned', custom: 'not-returned'
  }) }), { SOURCE: 'wx_client,scf', OPENID: 'caller', FROM_OPENID: 'external' })
  assert.deepEqual(getInvocationContext({ environment: '{"TCB_SOURCE":"wx_trigger"}' }), { SOURCE: 'wx_trigger' })
})

test('legacy current context preserves full values and excludes credentials', () => {
  assert.deepEqual(getInvocationContext({ environ: 'TCB_SOURCE=wx_client,scf;WX_OPENID=user=value;WX_FROM_OPENID=other;TOKEN=secret;trailing' }),
    { SOURCE: 'wx_client,scf', OPENID: 'user=value', FROM_OPENID: 'other' })
  assert.deepEqual(getInvocationContext({ environ: 'TCB_SOURCE=wx_trigger;WX_OPENID=;WX_FROM_OPENID=' }), { SOURCE: 'wx_trigger' })
})

test('modern context wins and malformed modern context never falls back', () => {
  const old = 'TCB_SOURCE=wx_trigger'
  assert.deepEqual(getInvocationContext({ environment: '{"TCB_SOURCE":"wx_client"}', environ: old }), { SOURCE: 'wx_client' })
  for (const environment of ['', null, undefined, {}, 'invalid', 'null', '[]', '{}', '"wx_trigger"']) {
    assert.deepEqual(getInvocationContext({ environment, environ: old }), {})
  }
})

test('missing current source ignores process state and event-like objects', () => {
  const previous = process.env.TCB_SOURCE
  process.env.TCB_SOURCE = 'wx_trigger'
  try {
    for (const input of [undefined, null, [], 'x', {}, { SOURCE: 'wx_trigger' },
      { Type: 'Timer', TriggerName: 'publicStatsHourly' },
      { environment: '{"WX_OPENID":"user"}' }, { environ: 'WX_OPENID=user' }]) {
      assert.deepEqual(getInvocationContext(input), {})
    }
  } finally {
    if (previous === undefined) delete process.env.TCB_SOURCE
    else process.env.TCB_SOURCE = previous
  }
})

test('ambiguous legacy source or identity fails closed', () => {
  for (const environ of ['TCB_SOURCE=wx_client;TCB_SOURCE=wx_trigger',
    'TCB_SOURCE=wx_trigger;WX_OPENID=user;WX_OPENID=',
    'TCB_SOURCE=wx_trigger;WX_FROM_OPENID=user;WX_FROM_OPENID=']) {
    assert.deepEqual(getInvocationContext({ environ }), {})
  }
})

test('unexpected field types fail closed and inherited fields are ignored', () => {
  for (const raw of [{ TCB_SOURCE: ['wx_trigger'] }, { TCB_SOURCE: 1 },
    { TCB_SOURCE: '' }, { TCB_SOURCE: 'x'.repeat(257) },
    { TCB_SOURCE: 'wx_trigger', WX_OPENID: null },
    { TCB_SOURCE: 'wx_trigger', WX_OPENID: 123 },
    { TCB_SOURCE: 'wx_trigger', WX_FROM_OPENID: [] }]) {
    assert.deepEqual(getInvocationContext({ environment: JSON.stringify(raw) }), {})
  }
  assert.deepEqual(getInvocationContext(Object.create({ environ: 'TCB_SOURCE=wx_trigger' })), {})
  assert.deepEqual(getInvocationContext({ environment: '{"__proto__":{"TCB_SOURCE":"wx_trigger"}}' }), {})
})

test('real handler uses its second argument, rejecting forged timer fields before any DB read', async () => {
  const { createHandler } = require('../cloudfunctions/statistics/sync')
  let reads = 0
  let sent = 0
  const run = createHandler({ getContext: getInvocationContext, getKey: () => Buffer.alloc(32, 1),
    readPublicStats: async () => { reads++; return { servedTrips: 1, coverageText: 'NY' } },
    send: async () => { sent++ }, now: () => 1800000000000 })
  const event = { Type: 'Timer', TriggerName: 'publicStatsHourly',
    environment: '{"TCB_SOURCE":"wx_trigger"}', SOURCE: 'wx_trigger' }
  for (const invocation of [undefined, {},
    { environment: '{"TCB_SOURCE":"wx_client"}' },
    { environment: '{"TCB_SOURCE":"wx_trigger,scf"}' },
    { environment: '{"TCB_SOURCE":"wx_trigger","WX_OPENID":"caller"}' },
    { environment: '{"TCB_SOURCE":"wx_trigger","WX_FROM_OPENID":"caller"}' }]) {
    assert.equal((await run(event, invocation)).error, 'TIMER_ONLY')
  }
  assert.equal(reads, 0)
  assert.equal(sent, 0)
  assert.equal((await run(event, { environment: '{"TCB_SOURCE":"wx_trigger"}' })).ok, true)
  assert.equal(reads, 1)
  assert.equal(sent, 1)
})
