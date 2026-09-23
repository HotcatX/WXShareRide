const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createStatisticsHandler } = require('../cloudfunctions/statistics/handler')
const { normalizeStats } = require('../cloudfunctions/statistics/public')
const { verifyRelay, deriveRelayKey } = require('../cloudfunctions/statistics/relay')
const { makeRelay, createLegacyTimer } = require('../cloudfunctions/syncPublicStatsReplica/relay')
const NOW = 1800000000000
const KEY = Buffer.alloc(32, 8)
const timer = { Type: 'Timer', TriggerName: 'publicStatsHourly' }
const context = (source, identity = {}) => ({ environment: JSON.stringify({ TCB_SOURCE: source, ...identity }) })
function setup() {
  const state = { reads: 0, sends: [], participation: [], logs: [] }
  const deps = { getSyncKey: () => KEY,
    readPublicStats: async () => { state.reads++; return { servedTrips: '12.9', coverageText: 'NY / NJ', _openid: 'private', lastTripId: 'private' } },
    participation: async (event, invocation) => { state.participation.push([event,invocation]); return { ok: true, marker: 'participation' } },
    send: async (snapshot, key) => state.sends.push({ snapshot, key }), now: () => NOW, log: value => state.logs.push(value) }
  return { state, deps, run: (event, ctx) => createStatisticsHandler(deps)(event, ctx) }
}

test('public action preserves the response envelope and only three public fields', async () => {
  const h = setup()
  assert.deepEqual(await h.run({ action: 'publicStats' }), { success: true, data: { _id: 'home', servedTrips: 12, coverageText: 'NY / NJ' } })
  assert.equal(h.state.reads, 1); assert.equal(h.state.sends.length, 0)
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
    assert.equal((await h.run(event, ctx)).marker, 'participation')
    assert.equal(h.state.participation.at(-1)[0], event); assert.equal(h.state.participation.at(-1)[1], ctx)
  }
  assert.equal((await h.run({ action: 'consent' }, ctx)).error, 'INVALID_ACTION')
  assert.equal(h.state.reads, 0); assert.equal(h.state.sends.length, 0)
})

test('direct Timer requires the original trusted trigger context and supports the canonical action alias', async () => {
  const h = setup()
  for (const ctx of [undefined, {}, context('wx_client'), context('wx_trigger,scf'), context('wx_trigger',{WX_OPENID:'user'})]) {
    assert.equal((await h.run({ ...timer, action:'publicStatsHourlyTimer' }, ctx)).error, 'TIMER_ONLY')
  }
  assert.equal(h.state.reads, 0)
  assert.equal((await h.run(timer, context('wx_trigger'))).ok, true)
  assert.equal((await h.run({...timer,action:'publicStatsHourlyTimer'},context('wx_trigger'))).ok, true)
  assert.equal(h.state.reads, 2)
  const snapshot = h.state.sends[0].snapshot
  assert.deepEqual(snapshot.data,{_id:'home',servedTrips:12,coverageText:'NY / NJ'})
  assert.equal(snapshot.expiresAt-snapshot.snapshotAt,7200000)
  assert.equal(JSON.stringify(h.state.sends).includes('private'),false)
})

test('legacy relay uses a domain-separated key, five-minute clock window and no user identity', async () => {
  const h = setup(); const relay = makeRelay(KEY, NOW)
  assert.notDeepEqual(deriveRelayKey(KEY), KEY)
  const rawKeySignature = crypto.createHmac('sha256',KEY).update(`legacyPublicStatsTimer\n${NOW}`).digest('hex')
  assert.equal(verifyRelay({...relay,signature:rawKeySignature},{SOURCE:'scf'},KEY,NOW),false)
  for (const [event,ctx] of [
    [{...relay,signature:'a'.repeat(64)},context('scf')], [makeRelay(KEY,NOW-300001),context('scf')],
    [makeRelay(KEY,NOW+300001),context('scf')], [{...relay,openid:'injected'},context('scf')],
    [relay,undefined], [relay,{environment:'malformed'}], [relay,context('scf',{WX_OPENID:'user'})],
    [relay,context('scf',{WX_FROM_OPENID:'user'})],
  ]) assert.equal((await h.run(event,ctx)).error,'RELAY_UNAUTHORIZED')
  assert.equal(h.state.reads,0)
  // Do not guess that the real cross-function source is a particular string.
  assert.equal((await h.run(relay,context('future_cross_function_source'))).ok,true)
  assert.equal((await h.run(makeRelay(KEY,NOW-300000),context('scf'))).ok,true)
  assert.equal((await h.run(makeRelay(KEY,NOW+300000),context('scf'))).ok,true)
  assert.equal(h.state.reads,3)
})

test('legacy timer wrapper authenticates original Timer before signing/calling canonical function', async () => {
  const calls=[]
  const run=createLegacyTimer({getKey:()=>KEY,now:()=>NOW,invoke:async value=>{calls.push(value);return {result:{ok:true,snapshotAt:NOW}}}})
  for(const ctx of [undefined,context('wx_client'),context('wx_trigger',{WX_OPENID:'private'})]) {
    assert.equal((await run(timer,ctx)).error,'TIMER_ONLY')
  }
  assert.equal((await run({...timer,TriggerName:'other'},context('wx_trigger'))).error,'TIMER_ONLY')
  assert.equal(calls.length,0)
  assert.deepEqual(await run(timer,context('wx_trigger')),{ok:true,snapshotAt:NOW})
  assert.equal(calls[0].name,'statistics')
  assert.equal(verifyRelay(calls[0].data,{SOURCE:'scf'},KEY,NOW),true)
})

test('legacy timer and canonical publication failures are sanitized',async()=>{
  const h=setup();h.deps.send=async()=>{throw Error('private key or transport payload')}
  await assert.rejects(h.run(timer,context('wx_trigger')),/^Error: PUBLIC_STATS_SYNC_FAILED$/)
  assert.equal(JSON.stringify(h.state.logs).includes('private'),false)
  const wrapper=createLegacyTimer({getKey:()=>KEY,invoke:async()=>{throw Error('private details')}})
  await assert.rejects(wrapper(timer,context('wx_trigger')),/^Error: PUBLIC_STATS_SYNC_FAILED$/)
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
  const {createHandler,PURPOSE,NOTICE}=require('../cloudfunctions/statistics/bridge')
  const {APPID}=require('../cloudfunctions/statistics/context')
  const keys={bridge:Buffer.alloc(32,1),subject:Buffer.alloc(32,2)}
  const realOpenid='authenticated_account_123456'
  const trusted=context('wx_client',{WX_APPID:APPID,WX_OPENID:realOpenid})
  const none={ok:true,status:'none',statusVersion:0,purposeVersion:PURPOSE,noticeVersion:NOTICE}
  const transmitted=[]
  const participation=createHandler({getKeys:()=>keys,transport:async(body)=>{transmitted.push(body);return none}})
  const h=setup();h.deps.participation=participation
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

test('ignoring platform metadata cannot authenticate a fabricated Timer or bypass a relay signature',async()=>{
  const h=setup()
  const userInfo={SOURCE:'wx_trigger',OPENID:'',appId:'spoofed'}
  const tcbContext={environment:JSON.stringify({TCB_SOURCE:'wx_trigger'}),SOURCE:'wx_trigger'}
  assert.equal((await h.run({...timer,userInfo,tcbContext},context('wx_client',{WX_OPENID:'caller'}))).error,'TIMER_ONLY')
  const relay=makeRelay(KEY,NOW)
  assert.equal((await h.run({...relay,userInfo,tcbContext,signature:'0'.repeat(64)},context('scf'))).error,'RELAY_UNAUTHORIZED')
  assert.equal((await h.run({...relay,userInfo,tcbContext},context('scf',{WX_OPENID:'caller'}))).error,'RELAY_UNAUTHORIZED')
  assert.equal(h.state.reads,0)
  assert.equal((await h.run({...relay,userInfo,tcbContext},context('scf'))).ok,true)
  assert.equal((await h.run({...relay,userInfo,tcbContext,extra:true},context('scf'))).error,'RELAY_UNAUTHORIZED')
  assert.equal(h.state.reads,1)
})

test('five-minute business timer authenticates separately and never runs public stats database path', async () => {
  const h = setup(); let calls = 0
  h.deps.synchronizePlaces = async () => { calls++; return { ok: true, delivered: 3 } }
  const event = { Type: 'Timer', TriggerName: 'placeBusinessFiveMinutes' }
  for (const ctx of [undefined, context('wx_client'), context('wx_trigger', { WX_OPENID: 'user' })]) {
    assert.equal((await h.run(event, ctx)).error, 'TIMER_ONLY')
  }
  assert.equal((await h.run({ action: 'placeBusinessTimer', ...event }, context('wx_trigger'))).delivered, 3)
  assert.equal(calls, 1); assert.equal(h.state.reads, 0); assert.equal(h.state.sends.length, 0)
  assert.equal((await h.run(timer, context('wx_trigger'))).ok, true)
  assert.equal(calls, 1); assert.equal(h.state.reads, 1)
})
