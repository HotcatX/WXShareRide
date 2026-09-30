const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createStatisticsHandler } = require('../cloudfunctions/statistics/handler')
const { normalizeStats } = require('../cloudfunctions/statistics/public')
const context = (source, identity = {}) => ({ environment: JSON.stringify({ TCB_SOURCE: source, ...identity }) })
function setup() {
  const state = { reads: 0, account: [] }
  const deps = { authority: 'server',
    readPublicStats: async () => { state.reads++; return { servedTrips: '12.9', coverageText: 'NY / NJ', _openid: 'private', lastTripId: 'private' } },
    account: async (event, invocation) => { state.account.push([event,invocation]); return { ok: true, marker: 'account' } } }
  return { state, deps, run: (event, ctx) => createStatisticsHandler(deps)(event, ctx) }
}

test('public action preserves the response envelope and only three public fields', async () => {
  const h = setup()
  assert.deepEqual(await h.run({ action: 'publicStats' }), { success: true, data: { _id: 'home', servedTrips: 12, coverageText: 'NY / NJ' } })
  assert.equal(h.state.reads, 1)
  assert.equal((await h.run({ action: 'publicStats', openid: 'private' })).success, false)
  assert.equal(h.state.reads, 1)
  assert.deepEqual(normalizeStats({ servedTrips: Number.MAX_VALUE, coverageText: { private: 'field' } }), { _id: 'home', servedTrips: null, coverageText: 'N/A' })
  h.deps.readPublicStats = async () => { throw Error('private database stack') }
  const failed = await h.run({ action: 'publicStats' })
  assert.equal(failed.success, false); assert.equal(failed.errorMsg, 'PUBLIC_STATS_UNAVAILABLE')
  assert.equal(JSON.stringify(failed).includes('private'), false)
})

test('authorization actions preserve the exact existing request/context and do not invoke the public database path', async () => {
  const h = setup(); const ctx = context('wx_client')
  for (const action of ['status','activate','withdraw']) {
    const event = { action, requestId: 'operation_identifier', expectedStatusVersion: 0 }
    assert.equal((await h.run(event, ctx)).marker, 'account')
    assert.equal(h.state.account.at(-1)[0], event); assert.equal(h.state.account.at(-1)[1], ctx)
  }
  assert.equal((await h.run({ action: 'consent' }, ctx)).error, 'INVALID_ACTION')
  assert.equal(h.state.reads, 0)
})

test('old public wrapper ignores caller arguments, does not read DB, and delegates a fixed public action',async()=>{
  const calls=[];const result={success:true,data:{_id:'home',servedTrips:12,coverageText:'NY'}}
  const module={exports:{}}
  const cloud={DYNAMIC_CURRENT_ENV:'test',init(){},database(){throw Error('wrapper must not read database')},
    async callFunction(value){calls.push(value);return {result}}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../cloudfunctions/getPublicStats/index.js'),'utf8'),
    {require:()=>cloud,exports:module.exports,module})
  assert.equal(await module.exports.main({action:'withdraw',openid:'spoof'}),result)
  assert.equal(JSON.stringify(calls[0]),JSON.stringify({name:'statistics',data:{action:'publicStats'}}))
  cloud.callFunction=async()=>{throw Error('private SDK payload')}
  const failed=await module.exports.main()
  assert.equal(failed.success,false);assert.equal(failed.errorMsg,'PUBLIC_STATS_UNAVAILABLE')
})

test('reserved userInfo and tcbContext are ignored without reading them, mutating the event or weakening other public fields',async()=>{
  const h=setup()
  const event={action:'publicStats'}
  for (const field of ['userInfo','tcbContext']) Object.defineProperty(event,field,{enumerable:true,get(){throw Error('reserved metadata must not be read')}})
  assert.equal((await h.run(event)).success,true)
  assert.deepEqual(Object.keys(event),['action','userInfo','tcbContext'])
  for(const userInfo of [null,{},'untrusted',{openid:'spoof',action:'withdraw'}]) {
    assert.equal((await h.run({action:'publicStats',userInfo,tcbContext:userInfo})).success,true)
    assert.equal((await h.run({action:'publicStats',tcbContext:userInfo})).success,true)
    const reads=h.state.reads
    assert.equal((await h.run({action:'publicStats',userInfo,tcbContext:userInfo,openid:'extra'})).errorMsg,'INVALID_REQUEST')
    assert.equal((await h.run({action:'publicStats',userInfo,tcbContext:userInfo,debug:true})).errorMsg,'INVALID_REQUEST')
    assert.equal(h.state.reads,reads)
  }
})

test('status/activate/withdraw accept platform metadata but authenticate only invocation context',async()=>{
  const {createAccountHandler,PURPOSE,NOTICE}=require('../cloudfunctions/statistics/bridge')
  const {APPID}=require('../cloudfunctions/statistics/context')
  const keys={bridge:Buffer.alloc(32,1),subject:Buffer.alloc(32,2)}
  const realOpenid='authenticated_account_123456'
  const trusted=context('wx_client',{WX_APPID:APPID,WX_OPENID:realOpenid})
  const none={ok:true,status:'none',statusVersion:0,purposeVersion:PURPOSE,noticeVersion:NOTICE}
  const transmitted=[]
  const account=createAccountHandler({getKeys:()=>keys,transport:async(body)=>{transmitted.push(body);return none}})
  const h=setup();h.deps.account=account
  for(const action of ['status','activate','withdraw']) {
    const event={action,requestId:'platform_event_request_123',expectedStatusVersion:0,purposeVersion:PURPOSE,noticeVersion:NOTICE,
      userInfo:{openId:'spoofed_account_123456',appId:'another-app',phone:'never-transmitted'},
      tcbContext:{TCB_SOURCE:'wx_client',WX_OPENID:'spoofed_account_123456',WX_APPID:APPID}}
    assert.deepEqual(await h.run(event,trusted),none)
    assert.equal(transmitted.at(-1).openid,realOpenid)
    assert.equal(Object.hasOwn(event,'userInfo'),true)
    assert.equal(Object.hasOwn(event,'tcbContext'),true)
    const body=transmitted.at(-1)
    assert.equal(body.accountSubject,crypto.createHmac('sha256',keys.subject).update(`linkx-research-account-v1\n${APPID}\n${realOpenid}`).digest('hex'))
    assert.equal(JSON.stringify(body).includes('spoofed'),false)
    assert.equal(JSON.stringify(body).includes('never-transmitted'),false)
    assert.equal((await h.run({...event,openid:'extra'},trusted)).error,'INVALID_REQUEST')
    assert.equal((await h.run({...event,debug:true},trusted)).error,'INVALID_REQUEST')
    assert.equal((await h.run(event,{})).error,'LOGIN_REQUIRED')
    assert.equal((await h.run(event,context('wx_client',{WX_APPID:'wrong',WX_OPENID:realOpenid}))).error,'LOGIN_REQUIRED')
  }
  assert.equal(transmitted.length,3)
  assert.equal(h.state.reads,0)
})

test('all retired timer and relay forms are rejected without reading statistics or account state', async () => {
  const h = setup()
  const events = [
    { Type: 'Timer', TriggerName: 'publicStatsHourly' },
    { Type: 'Timer', TriggerName: 'placeBusinessFiveMinutes' },
    { action: 'publicStatsHourlyTimer' }, { action: 'placeBusinessTimer' },
    { action: 'legacyPublicStatsTimer', timestamp: '1800000000000', signature: 'a'.repeat(64) },
    null, {}, { action: 'unknown' }
  ]
  for (const event of events) {
    for (const ctx of [undefined, context('wx_client'), context('wx_trigger'), context('scf')]) {
      assert.deepEqual(await h.run(event, ctx), { ok: false, error: 'INVALID_ACTION' })
    }
  }
  assert.equal(h.state.reads, 0); assert.equal(h.state.account.length, 0)
})

function actualEntry() {
  const directory = path.resolve(__dirname, '../cloudfunctions/statistics')
  const calls = [], keyReads = [], modules = new Map()
  const keys = { bridge: '11'.repeat(32), subject: '22'.repeat(32) }
  const request = (url, options, callback) => {
    const req = new EventEmitter()
    req.destroy = () => {}
    req.end = raw => queueMicrotask(() => {
      calls.push({ url, options, raw })
      const body = raw ? JSON.parse(raw) : undefined
      const response = body ? { ok: true, status: 'none', statusVersion: 0,
        purposeVersion: body.purposeVersion, noticeVersion: body.noticeVersion }
        : { ok: true, data: { servedCount: 55, coverageText: 'NY / NJ' } }
      const res = new EventEmitter()
      Object.assign(res, { statusCode: 200, headers: {}, destroy() {} })
      callback(res); res.emit('data', Buffer.from(JSON.stringify(response))); res.emit('end')
    })
    return req
  }
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(filename),
      Buffer, TextDecoder, Date, setTimeout, clearTimeout,
      require(id) {
        if (id === 'fs') return { readFileSync(file) {
          assert.equal(file, path.join(directory, 'analytics.secret.json'))
          keyReads.push(file); return JSON.stringify(keys)
        } }
        if (id === 'https') return { request }
        if (id === 'path' || id === 'crypto') return require(id)
        assert.match(id, /^\.\/[a-zA-Z-]+$/, 'entry must use only built-ins and local modules')
        return load(path.join(directory, id + '.js'))
      }
    }, { filename })
    return module.exports
  }
  return { main: load(path.join(directory, 'index.js')).main, calls, keyReads, keys }
}

test('actual dependency-free entry reads the fixed PG API and never loads obsolete sync credentials', async () => {
  const h = actualEntry()
  const result = await h.main({ action: 'publicStats', userInfo: { openid: 'ignored' } })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    success: true, data: { _id: 'home', servedTrips: 55, coverageText: 'NY / NJ' }
  })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, 'https://collect.linkx.ink/api/v1/statistics/public')
  assert.equal(h.calls[0].options.method, 'GET')
  for (const event of [{ Type: 'Timer', TriggerName: 'publicStatsHourly' },
    { action: 'placeBusinessTimer' }, { action: 'legacyPublicStatsTimer' }]) {
    assert.equal((await h.main(event, context('wx_trigger'))).error, 'INVALID_ACTION')
  }
  assert.equal(h.calls.length, 1); assert.equal(h.keyReads.length, 0)
  const pkg = require('../cloudfunctions/statistics/package.json')
  const lock = require('../cloudfunctions/statistics/package-lock.json')
  assert.equal(pkg.dependencies, undefined)
  assert.deepEqual(Object.keys(lock.packages), [''])
  for (const file of ['sync.js', 'relay.js', 'placesSync.js', 'businessOutbox.js', 'timer-context.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '../cloudfunctions/statistics', file)), false)
  }
})

test('actual entry preserves the account bridge endpoint, signed bytes and trusted identity for all supported actions', async () => {
  const h = actualEntry()
  const { APPID } = require('../cloudfunctions/statistics/context')
  const { PURPOSE, NOTICE } = require('../cloudfunctions/statistics/bridge')
  const openid = 'actual_entry_account_123456'
  const ctx = context('wx_client', { WX_APPID: APPID, WX_OPENID: openid })
  for (const action of ['status', 'activate', 'withdraw']) {
    const result = await h.main({ action, requestId: 'actual_entry_operation_12345',
      expectedStatusVersion: 0, purposeVersion: PURPOSE, noticeVersion: NOTICE,
      userInfo: { openid: 'untrusted' }, tcbContext: { openid: 'untrusted' } }, ctx)
    assert.equal(result.ok, true)
    const call = h.calls.at(-1), body = JSON.parse(call.raw), headers = call.options.headers
    assert.equal(call.url, 'https://collect.linkx.ink/internal/v1/analytics/accounts')
    assert.equal(call.options.method, 'POST')
    assert.equal(body.action, action); assert.equal(body.openid, openid)
    assert.equal(call.raw.includes('untrusted'), false)
    assert.equal(body.accountSubject, crypto.createHmac('sha256', Buffer.from(h.keys.subject, 'hex'))
      .update(`linkx-research-account-v1\n${APPID}\n${openid}`).digest('hex'))
    assert.equal(headers['X-Linkx-Signature'], crypto.createHmac('sha256', Buffer.from(h.keys.bridge, 'hex'))
      .update(`${headers['X-Linkx-Timestamp']}\n${headers['X-Linkx-Nonce']}\n${call.raw}`).digest('hex'))
  }
  assert.equal(h.calls.length, 3); assert.equal(h.keyReads.length, 3)
})
