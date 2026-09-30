const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { validateEvent } = require('../utils/analyticsSchema')
const plain = v => JSON.parse(JSON.stringify(v))
const CODE = 'ref_123456789abc', OTHER = 'ref_abcdef123456'
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
function harness(overrides = {}) {
  const state = { metadata: { sessionId: 'synthetic_foreground_session_1', context: { clientVersion: '5.1.0', buildMode: 'trial' } }, now: Date.now(), sequence: 0, ready: false, preview: false, gets: [], mutations: [], cloud: [], records: [], listeners: [] }
  const storage = { openid: 'synthetic-account-a', isGuest: false }
  const wx = { getStorageSync: key => storage[key] === undefined ? undefined : plain(storage[key]),
    setStorageSync: (key,value) => { storage[key]=plain(value) }, removeStorageSync: key => {delete storage[key]},
    cloud: { callFunction: async options => {state.cloud.push(options);return {result:{ok:true,referralCode:CODE}}} } }
  const backend = { isBackendEnabled: () => true,
    get: url => { state.gets.push(url);return Promise.resolve({code:CODE,referralCount:2}) },
    mutate: (...args) => {state.mutations.push(plain(args));return Promise.resolve({changed:true})}, ...overrides }
  const analytics = {
    getEventMetadata: () => state.metadata ? plain(state.metadata) : null,
    makeEventId: () => `synthetic_referral_event_${++state.sequence}`,
    subscribe: callback => {state.listeners.push(callback);callback({collectionReady:state.ready});return ()=>{}},
    recordEvent: (name,data,meta) => {
      if (!state.ready) return {ok:false,reason:'not_participating'}
      if (state.reenter) state.listeners.forEach(cb=>cb({collectionReady:true}))
      state.records.push(plain({name,data,meta}));return {ok:true}
    }
  }
  const transport = {exports:{}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/compat/referrals.js'),'utf8'),{
    module:transport,wx,require:()=>backend
  })
  const module={exports:{}}, clock=class extends Date { static now(){return state.now} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/referral.js'),'utf8'),{
    module,wx,Date:clock,require:name=> name==='./timeline'?{isTimelinePreview:()=>state.preview}:name==='./analyticsSession'?analytics:transport.exports
  })
  const ready=()=>{state.ready=true;state.listeners.forEach(cb=>cb({collectionReady:true}))}
  return {api:module.exports,transport:transport.exports,wx,backend,state,storage,ready,analytics}
}
const capture=(h,code=CODE)=>h.api.captureReferral({path:'pages/home/tripDetail/tripDetail',query:{ref:code,phone:'must-not-leak'},scene:1001},'appShow')

test('server own-code requests deduplicate and bind sends only code with one stable SDK operation scope',async()=>{
  const wait=deferred(),h=harness({get:()=>wait.promise})
  const first=h.api.ensureReferralCode(),second=h.api.ensureReferralCode()
  assert.equal(first,second)
  wait.resolve({code:OTHER,referralCount:2});assert.equal(await first,OTHER)
  assert.equal(h.storage.my_referral_code.openid,h.storage.openid)
  capture(h);await h.api.bindPendingReferral()
  assert.deepEqual(h.state.mutations.map(args=>args.slice(0,4)),[['referrals.bind','POST','/api/v1/referrals/bind',{code:CODE}]])
  assert.equal(h.storage.pending_referral.bound,true)
  assert.equal(h.api.getReferralStatus().pendingVisits,1)
  assert.deepEqual(h.state.cloud,[])
})

test('an old unowned code and another account cache never become the current account share code',async()=>{
  const h=harness();h.storage.my_referral_code=CODE
  assert.equal(h.api.getMyReferralCodeSync(),'')
  h.api.setMyReferralCode(CODE);h.storage.openid='account-b'
  assert.equal(h.api.getMyReferralCodeSync(),'')
  assert.deepEqual(plain(h.api.withReferralShare({path:'/pages/home/home'})),{path:'/pages/home/home'})
  h.storage.userInfo={_openid:'account-b',referralCode:OTHER}
  assert.equal(h.api.getMyReferralCodeSync(),OTHER)
})

test('late A-to-B-to-A own-code replies cannot overwrite the latest account request',async()=>{
  const a=deferred(),b=deferred(),fresh=deferred(),queue=[a,b,fresh]
  const h=harness({get:()=>queue.shift().promise})
  const old=h.api.ensureReferralCode();h.storage.openid='account-b';const middle=h.api.ensureReferralCode()
  h.storage.openid='synthetic-account-a';const latest=h.api.ensureReferralCode()
  fresh.resolve({code:OTHER});await latest;a.resolve({code:CODE});b.resolve({code:CODE});await Promise.all([old,middle])
  assert.equal(h.api.getMyReferralCodeSync(),OTHER)
})

test('guest visit keeps the original capture time, becomes queued after activation and survives duplicate hooks/reentry',async()=>{
  const h=harness();h.storage.isGuest=true;h.storage.openid=''
  capture(h);const captured=h.storage.pending_referral.visits[0]
  capture(h);assert.equal(h.storage.pending_referral.visits.length,1)
  assert.equal(h.state.records.length,0)
  assert.equal(h.state.cloud.length,0)
  h.state.now+=1000;h.storage.openid='signed-in-user';h.storage.isGuest=false
  await h.api.bindPendingReferral() // binding success must not fabricate an analytics success
  assert.equal(h.state.records.length,0)
  h.state.reenter=true;h.ready();h.ready();h.api.flushReferralVisits();capture(h)
  const visits=h.state.records.filter(e=>e.name==='referral_visit')
  assert.equal(visits.length,1)
  assert.equal(visits[0].meta.eventId,captured.eventId)
  assert.equal(visits[0].meta.occurredAt,captured.occurredAt)
  assert.deepEqual(visits[0].data,{code:CODE,source:'appShow',entry:'trip_detail'})
  assert.equal(JSON.stringify(h.storage.pending_referral).includes('must-not-leak'),false)
  assert.equal(h.api.getReferralStatus().pendingVisits,0)
})

test('late bind ACK cannot remove a newly captured invitation or bind an old account invitation for another user',async()=>{
  const wait=deferred(),h=harness({mutate:()=>wait.promise})
  capture(h);const binding=h.api.bindPendingReferral();h.state.now+=11000;capture(h,OTHER)
  wait.resolve({changed:true});await binding
  assert.equal(h.storage.pending_referral.referralCode,OTHER)
  assert.equal(h.storage.pending_referral.bound,false)
  h.storage.openid='other-account'
  assert.equal(await h.api.bindPendingReferral(),null)
  h.ready();assert.equal(h.state.records.length,0)
})

test('uncertain bind failures retain intent, return an explicit error and never call legacy writes',async()=>{
  const h=harness({mutate:()=>Promise.reject(Object.assign(new Error('transport detail'),{code:'NETWORK_ERROR'}))})
  capture(h);const result=await h.api.bindPendingReferral()
  assert.equal(result.ok,false);assert.equal(result.error,'NETWORK_ERROR')
  assert.equal(h.storage.pending_referral.bound,false)
  assert.deepEqual(h.state.cloud,[])
})

test('preview does no storage/network/analytics work and strict server codes are not sanitized into another invitation',async()=>{
  const h=harness();h.state.preview=true
  capture(h);await h.api.ensureReferralCode();await h.api.bindPendingReferral()
  assert.equal(h.storage.pending_referral,undefined);assert.equal(h.state.listeners.length,0)
  h.state.preview=false;capture(h,CODE+'!')
  assert.equal(h.storage.pending_referral,undefined)
})

test('bounded pending visits report queue overflow and expiry through existing diagnostics',()=>{
  const h=harness()
  for(let i=0;i<34;i++){h.state.now+=11000;capture(h)}
  assert.equal(h.storage.pending_referral.visits.length,32)
  assert.equal(h.api.getReferralStatus().droppedVisits,2)
  h.state.now+=8*86400000;h.ready()
  assert.equal(h.state.records.filter(e=>e.name==='referral_visit').length,0)
  assert.deepEqual(h.state.records.map(e=>e.data),[{reason:'queue_limit',droppedCount:2},{reason:'expired',droppedCount:32}])
})

test('referrals reject unready and non-server authority without a legacy call or new mutation',async()=>{
  const {createBackendClient}=require('../utils/backendClient')
  for(const [mode,ready,code] of [['server',false,'BACKEND_NOT_READY'],['cloudbase',true,'BACKEND_DISABLED'],['invalid',true,'BACKEND_DISABLED']]){
    const h=harness()
    h.wx.request=()=>assert.fail('blocked authority must not send HTTP')
    Object.assign(h.backend,createBackendClient({wx:h.wx,authority:{getMode:()=>mode,isReady:()=>ready,subscribe(){}}}))
    for(const action of ['getMyReferralCode','bindReferral'])await assert.rejects(h.transport.call(action,{referralCode:CODE}),{code})
    assert.deepEqual(h.state.cloud,[]);assert.deepEqual(h.state.mutations,[])
  }
})

test('client and collector agree on referral_visit and reject metadata/contact smuggling and invalid codes',async()=>{
  const {validateBatch}=await import('../services/analytics-collector/src/validation.mjs')
  const now=Date.now(),event={eventId:'synthetic_referral_event_1',eventName:'referral_visit',schemaVersion:1,occurredAt:now-12345,
    data:{code:CODE,source:'appShow',entry:'trip_detail'}}
  const batch=e=>({schemaVersion:1,batchId:'synthetic_referral_batch_1',events:[e]})
  assert.equal(validateEvent(event,now),true);assert.deepEqual(validateBatch(batch(event),now).events[0],event)
  for(const data of [{...event.data,query:{phone:'secret'}},{...event.data,path:'private/path'},{...event.data,code:'ref_short'},
    {...event.data,entry:'private'}, {...event.data,source:'arbitrary text'}]){
    const invalid={...event,data};assert.equal(validateEvent(invalid,now),false);assert.throws(()=>validateBatch(batch(invalid),now))
  }
})


test('pre-foreground capture waits for the first real session and freezes its context before guest activation',()=>{
  const h=harness();h.storage.isGuest=true;h.storage.openid='';h.state.metadata=null
  h.api.captureReferral({path:'pages/home/tripDetail/tripDetail',query:{ref:CODE}},'appLaunch')
  const first=plain(h.storage.pending_referral.visits[0])
  assert.equal(first.sessionId,undefined)
  h.state.metadata={sessionId:'actual_foreground_session_a',context:{clientVersion:'5.1.0',platform:'ios'}}
  capture(h)
  assert.equal(h.storage.pending_referral.visits.length,1)
  const frozen=plain(h.storage.pending_referral.visits[0])
  assert.equal(frozen.sessionId,'actual_foreground_session_a');assert.notEqual(frozen.sessionId,first.eventId)
  h.state.metadata={sessionId:'actual_foreground_session_b',context:{clientVersion:'5.2.0',platform:'ios'}}
  h.storage.openid='signed-in-user';h.storage.isGuest=false;h.ready()
  const event=h.state.records.find(e=>e.name==='referral_visit')
  assert.equal(event.meta.sessionId,frozen.sessionId);assert.deepEqual(event.meta.context,frozen.context)
  assert.equal(event.meta.occurredAt,first.occurredAt);assert.equal(event.meta.eventId,first.eventId)
})
