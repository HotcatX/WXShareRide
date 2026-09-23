const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { getIdentity, APPID } = require('../cloudfunctions/statistics/context')
const { createHandler, validRequest, projectResponse, send, PURPOSE, NOTICE, ENDPOINT } = require('../cloudfunctions/statistics/bridge')
const environment = { TCB_SOURCE: 'wx_client', WX_OPENID: 'test_account_openid_123456', WX_APPID: APPID }
const context = { environment: JSON.stringify(environment) }
const event = { action: 'status', requestId: 'status_request_123456', expectedStatusVersion: 0, purposeVersion: PURPOSE, noticeVersion: NOTICE }
const keys = { bridge: Buffer.alloc(32, 1), subject: Buffer.alloc(32, 2) }
const none = { ok: true, status: 'none', statusVersion: 0, purposeVersion: PURPOSE, noticeVersion: NOTICE }

test('trusted identity is invocation-local; client, environment fallback and cross-app cannot impersonate', () => {
  assert.deepEqual(getIdentity(context), { appid: APPID, openid: environment.WX_OPENID })
  assert.deepEqual(getIdentity({ environ: Object.entries(environment).map(([k,v])=>`${k}=${v}`).join(';') }), getIdentity(context))
  for (const input of [null, {}, {environment: '{}' }, {environment: 'null'}, {environment: 'bad', environ: 'TCB_SOURCE=wx_client'},
    {environment: JSON.stringify({...environment, WX_APPID:'other_app'})},
    {environment: JSON.stringify({...environment, WX_FROM_OPENID:'other_user'})},
    {environment: JSON.stringify({...environment, WX_FROM_APPID:APPID})},
    {environment: JSON.stringify({...environment, TCB_SOURCE:'wx_trigger'})},
    {environ:'TCB_SOURCE=wx_client;TCB_SOURCE=wx_client'}]) assert.equal(getIdentity(input), null)
  process.env.WX_OPENID=environment.WX_OPENID
  try { assert.equal(getIdentity({}), null) } finally { delete process.env.WX_OPENID }
  // Alternating invocations never inherit the previous authenticated user.
  assert.ok(getIdentity(context)); assert.equal(getIdentity({environment:'{}'}), null)
})

test('request rejects identity injection, extra fields, bad action/version/purpose', () => {
  assert.equal(validRequest(event), true)
  assert.equal(validRequest({...event,action:'activate'}), true)
  assert.equal(validRequest({...event,action:'consent'}), false)
  assert.equal(validRequest({...event,collectionMode:'test'}), true)
  for (const mode of ['real', '', 'TEST', true, null]) assert.equal(validRequest({...event,collectionMode:mode}), false)
  assert.equal(validRequest({...event,synthetic:true}), false)
  for (const request of [{...event, openid:'attacker'}, {...event, action:'token'}, {...event, expectedStatusVersion:-1},
    {...event, purposeVersion:'future'}, {...event, noticeVersion:'future'}, {...event, requestId:'short'}, null]) assert.ok(!validRequest(request))
})

test('same authenticated account gets separate test subject and signed kind without changing the real helper scope', async () => {
  const bodies=[]
  const handler=createHandler({getKeys:()=>keys,transport:async body=>{bodies.push(body);return body.synthetic ? {...none,synthetic:true}:none}})
  assert.deepEqual(await handler(event,context),none)
  const testReply=await handler({...event,collectionMode:'test'},context)
  assert.equal(testReply.synthetic,true)
  assert.equal(bodies[0].accountSubject,crypto.createHmac('sha256',keys.subject).update(`linkx-research-account-v1\n${APPID}\n${environment.WX_OPENID}`).digest('hex'))
  assert.equal(bodies[1].accountSubject,crypto.createHmac('sha256',keys.subject).update(`linkx-research-test-account-v1\n${APPID}\n${environment.WX_OPENID}`).digest('hex'))
  assert.notEqual(bodies[0].accountSubject,bodies[1].accountSubject)
  assert.equal(Object.hasOwn(bodies[0],'synthetic'),false)
  assert.equal(bodies[1].synthetic,true);assert.equal(bodies[1].collectionMode,undefined)
  assert.equal(bodies[0].openid,environment.WX_OPENID);assert.equal(bodies[1].openid,environment.WX_OPENID)
  assert.deepEqual(Object.keys(bodies[0]).sort(),['accountSubject','openid','action','requestId','expectedStatusVersion','purposeVersion','noticeVersion'].sort())
})

test('upstream namespace must match requested mode and cannot silently route test into real', async () => {
  assert.throws(()=>projectResponse({...none,synthetic:true}))
  assert.throws(()=>projectResponse(none,Date.now(),true))
  assert.throws(()=>projectResponse({...none,synthetic:'true'},Date.now(),true))
  assert.equal(projectResponse({...none,synthetic:true},Date.now(),true).synthetic,true)
  assert.equal(projectResponse({...none,synthetic:false}).synthetic,false)
  for(const [request,reply] of [[{...event,collectionMode:'test'},none],[event,{...none,synthetic:true}]]) {
    const handler=createHandler({getKeys:()=>keys,transport:async()=>reply})
    assert.equal((await handler(request,context)).error,'BRIDGE_UNAVAILABLE')
  }
})

test('bridge sends only trusted account identity with its scoped pseudonym, never caller identity or subject key', async () => {
  let transmitted
  const handler=createHandler({getKeys:()=>keys, transport:async(body,key)=>{transmitted={body,key};return none}})
  assert.deepEqual(await handler(event,context), none)
  assert.match(transmitted.body.accountSubject,/^[a-f0-9]{64}$/)
  assert.equal(transmitted.body.openid,environment.WX_OPENID)
  assert.equal(transmitted.key,keys.bridge)
  const first=transmitted.body.accountSubject
  await handler(event,{environment:JSON.stringify({...environment,WX_OPENID:'another_account_123456'})})
  assert.notEqual(transmitted.body.accountSubject,first)
  assert.equal(transmitted.body.openid,'another_account_123456')
  assert.equal((await handler({...event,openid:'spoof'},context)).error,'INVALID_REQUEST')
  assert.equal((await handler(event,{})).error,'LOGIN_REQUIRED')
})

test('unavailable or accidentally reused keys fail closed without details',async()=>{
  for(const getKeys of [()=>{throw Error('secret/private/path')},()=>({bridge:keys.bridge,subject:keys.bridge}),()=>({})]) {
    const response=await createHandler({getKeys,transport:()=>{throw Error('must not send')}})(event,context)
    assert.deepEqual(response,{ok:false,error:'BRIDGE_UNAVAILABLE',statusCode:503})
  }
})

test('upstream session projection rejects malformed/expired tokens and strips unknown fields',()=>{
  const now=Date.now()
  const active={...none,status:'active',statusVersion:1,participantKey:'participant_key_123',accountSubject:'secret',session:{participantKey:'participant_key_123',grantId:'grant_identifier_123',
    status:'active',statusVersion:1,confirmed:true,purposeVersion:PURPOSE,acceptedPurposeVersion:PURPOSE,
    token:'abc.def.ghi',tokenExpiresAtMs:now+899000,privateExtra:'secret'}}
  const projected=projectResponse(active,now)
  assert.equal(projected.accountSubject,undefined);assert.equal(projected.session.privateExtra,undefined)
  assert.equal(projectResponse({...active,session:undefined},now).session,undefined)
  for(const session of [{...active.session,participantKey:1234567890123456},{...active.session,tokenExpiresAtMs:now},
    {...active.session,tokenExpiresAtMs:now+931000},{...active.session,statusVersion:2}]) assert.throws(()=>projectResponse({...active,session},now))
})

function fakeRequest(status,data,inspect) {
  return (url,options,callback)=>{
    const req=new EventEmitter()
    req.destroy=()=>{}
    req.end=raw=>{
      inspect?.(url,options,raw)
      queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=status;callback(res)
        res.emit('data',Buffer.from(data));res.emit('end')
      })
    }
    return req
  }
}
test('HTTPS bridge signs exact raw body with fresh nonce and fixed destination',async()=>{
  const stamp=1700000000000,nonce='a'.repeat(32)
  const response=await send(event,keys.bridge,{now:()=>stamp,nonce:()=>nonce,request:fakeRequest(200,JSON.stringify(none),(url,opt,raw)=>{
    assert.equal(url,ENDPOINT);assert.equal(opt.method,'POST')
    assert.equal(opt.headers['X-Linkx-Signature'],crypto.createHmac('sha256',keys.bridge).update(`${stamp}\n${nonce}\n${raw}`).digest('hex'))
    assert.equal(opt.headers['Content-Length'],Buffer.byteLength(raw))
  })})
  assert.deepEqual(response,none)
})
test('upstream CAS conflicts survive; errors/redirects/oversized bodies never leak',async()=>{
  assert.deepEqual(await send(event,keys.bridge,{request:fakeRequest(409,JSON.stringify({ok:false,error:'OPERATION_SUPERSEDED'}))}),
    {ok:false,error:'OPERATION_SUPERSEDED',statusCode:409})
  assert.equal((await send(event,keys.bridge,{request:fakeRequest(503,JSON.stringify({ok:false,error:'secret_token'}))})).error,'BRIDGE_UNAVAILABLE')
  await assert.rejects(send(event,keys.bridge,{request:fakeRequest(302,JSON.stringify(none))}),/BRIDGE_UNAVAILABLE/)
  await assert.rejects(send(event,keys.bridge,{request:fakeRequest(200,'x'.repeat(8193))}),/BRIDGE_UNAVAILABLE/)
})
test('stalled upstream is aborted before the verified three-second cloud timeout',async()=>{
  let aborted=false
  const started=Date.now()
  await assert.rejects(send(event,keys.bridge,{request:()=>{
    const req=new EventEmitter(); req.end=()=>{}; req.destroy=()=>{aborted=true}; return req
  }}),/BRIDGE_UNAVAILABLE/)
  assert.ok(aborted)
  assert.ok(Date.now()-started<2900)
})
