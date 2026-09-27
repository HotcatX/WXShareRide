import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { createCollectionSessions } from '../src/analytics/session.ts';
import { createSignedCollectorRequest } from '../src/analytics/transport.ts';
import { collectionProtocol as protocol } from '../src/analytics/compat.ts';
import { createTestDatabase } from './helpers/database.ts';
import type { Config } from '../src/config.ts';

const require = createRequire(import.meta.url);
const { createHandler } = require('../../../cloudfunctions/statistics/bridge.js');
const oldProtocol = require('../../../cloudfunctions/statistics/compat.js');
const { createBackendClient, SESSION_KEY } = require('../../../utils/backendClient.js');
// @ts-expect-error Existing collector remains an independent JavaScript service.
const { createCollector } = await import('../../analytics-collector/src/server.mjs');
const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-analytics-user';
const input = (action='status', expectedStatusVersion=0, extra={}) => ({action,expectedStatusVersion,requestId:randomUUID(),
  purposeVersion:protocol.purpose,noticeVersion:protocol.notice,...extra});

test('normal analytics route reuses the existing CloudBase account/grant with actual PostgreSQL + collector SQLite',
  {skip:!process.env.BACKEND_TEST_DATABASE_URL}, async t => {
    const db = await createTestDatabase(), dir = mkdtempSync(join(tmpdir(),'linkx-session-'));
    const key = randomBytes(32), subjectKey = randomBytes(32);
    const collector = createCollector({dbPath:join(dir,'collector.sqlite'),port:0,host:'127.0.0.1',minFreeBytes:0,
      adminSocket:join(dir,'admin.sock'),adminToken:randomBytes(32).toString('base64url'),bridgeKey:key,
      privatePem:generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),
      purposeVersion:protocol.purpose,noticeVersion:protocol.notice,realEnabled:true});
    const address = await collector.start();
    t.after(async()=>{await collector.close();await db.close();rmSync(dir,{recursive:true,force:true});});
    let calls=0, lose=false;
    const transport: typeof fetch = async (url,options) => {
      assert.equal(String(url),`https://collector.example.test${protocol.path}`);calls++;
      const response = await fetch(`http://127.0.0.1:${address.port}${protocol.path}`,options);
      if(lose) {lose=false;await response.arrayBuffer();throw new Error('synthetic lost ACK');}
      return response;
    };
    const config:Config = {databaseUrl:'',host:'127.0.0.1',port:3100,appId,sessionTtlSeconds:3600,businessMode:'active',
      collector:{origin:'https://collector.example.test',key,subjectKey}};
    const app = await createApp({pool:db.pool,config,exchange:async()=>({openid}),collectorTransport:transport});t.after(()=>app.close());
    // Activate with the old deployed function's exact derivation first.
    assert.equal(oldProtocol.ENDPOINT,`https://collect.linkx.ink${protocol.path}`);
    assert.equal(oldProtocol.SUBJECT_SCOPE,protocol.subject);assert.equal(oldProtocol.TEST_SUBJECT_SCOPE,protocol.testSubject);
    const post = createSignedCollectorRequest(config.collector!,protocol.path,transport);
    const old = createHandler({getKeys:()=>({bridge:key,subject:subjectKey}),identity:()=>({appid:appId,openid}),
      transport:async(body:unknown)=> (await post(JSON.stringify(body))).body});
    const activated = await old(input('activate'),{});assert.equal(activated.ok,true);
    const account = createHmac('sha256',subjectKey).update(`${protocol.subject}\n${appId}\n${openid}`).digest('hex');
    assert.equal(collector.store.db.prepare('SELECT COUNT(*) AS n FROM research_accounts WHERE account_subject=?').get(account).n,1);
    const session = (await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{code:'synthetic'}})).json().data;
    const storage = new Map<string,unknown>([['openid',openid],['isGuest',false],[SESSION_KEY,session]]);
    const sdk = createBackendClient({config:{mode:'server'},wx:{getStorageSync:(k:string)=>storage.get(k),
      setStorageSync:(k:string,v:unknown)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),
      cloud:{callFunction:()=>assert.fail('should use verified session')},request(options:any){
        void app.inject({method:options.method,url:options.url.replace('https://collect.linkx.ink',''),headers:options.header,payload:options.data})
          .then(reply=>options.success({statusCode:reply.statusCode,data:reply.json()}));return{abort(){}};
      }}});
    const status = await sdk.collectionSession(input());
    assert.equal(status.participantKey,activated.participantKey);assert.equal(status.session.grantId,activated.session.grantId);
    assert.equal(collector.store.db.prepare('SELECT COUNT(*) AS n FROM research_accounts').get().n,1);
    const synthetic = await sdk.collectionSession(input('activate',0,{collectionMode:'test'}));
    assert.equal(synthetic.synthetic,true);assert.notEqual(synthetic.participantKey,status.participantKey);
    const withdrawal=input('withdraw',1);lose=true;
    await assert.rejects(sdk.collectionSession(withdrawal),{code:'COLLECTION_UNAVAILABLE'});
    const withdrawn=await sdk.collectionSession(withdrawal);assert.equal(withdrawn.status,'revoked');assert.equal(withdrawn.statusVersion,2);
    assert.equal((await sdk.collectionSession(input())).status,'revoked');
    assert.equal((await sdk.collectionSession(input('status',0,{collectionMode:'test'}))).status,'active');
    const oldStatus=await old(input(),{});assert.equal(oldStatus.status,'revoked');assert.equal(oldStatus.participantKey,status.participantKey);
    const before=calls;
    for(const extra of [{openid:'forged'}, {accountSubject:account}, {appId:'another'}, {synthetic:true}]) {
      await assert.rejects(sdk.collectionSession({...input(),...extra}),{code:'INVALID_INPUT'});
    }
    assert.equal(calls,before);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/analytics/session',payload:input()})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/analytics/session',payload:input(),
      headers:{authorization:`Bearer ${status.session.token}`}})).statusCode,401,'collector token cannot authenticate business APIs');
    const staged=await createApp({pool:db.pool,config:{...config,businessMode:'staged'},collectorTransport:transport});
    const stopped=await staged.inject({method:'POST',url:'/api/v1/analytics/session',payload:input(),headers:{authorization:`Bearer ${session.token}`}});
    assert.equal(stopped.statusCode,503);assert.equal(calls,before);await staged.close();
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n,1);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM idempotency_requests')).rows[0].n,0,'collector owns request receipts');
});

test('analytics rejects mismatched grant fields, malicious response extras, and unavailable configuration', async()=>{
  const config:Config={databaseUrl:'',host:'',port:3100,appId,sessionTtlSeconds:3600,businessMode:'active',
    collector:{origin:'https://collector.example.test',key:randomBytes(32),subjectKey:randomBytes(32)}};
  const user={id:randomUUID(),openid};
  await assert.rejects(createCollectionSessions({...config,collector:undefined})(user,input()),{code:'COLLECTION_UNAVAILABLE'});
  const base={ok:true,status:'none',statusVersion:0,purposeVersion:protocol.purpose,noticeVersion:protocol.notice};
  for(const reply of [{...base,secret:'never pass through'},{...base,synthetic:true},{...base,statusVersion:1},
    {...base,session:{}},{...base,participantKey:randomUUID()}]) {
    await assert.rejects(createCollectionSessions(config,async()=>new Response(JSON.stringify(reply)))(user,input()),{code:'COLLECTION_UNAVAILABLE'});
  }
  const call=createCollectionSessions(config,async()=>new Response(JSON.stringify({ok:false,error:'STATE_CONFLICT'}),{status:409}));
  await assert.rejects(call(user,input()),{code:'STATE_CONFLICT',status:409});
});
