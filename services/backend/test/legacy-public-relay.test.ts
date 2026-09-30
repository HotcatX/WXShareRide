import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { createLegacyPublicRelay } = require('../compat/legacy-public-relay.cjs');
const secret = 'Bearer SyntheticExistingSecret000000000000';
function transport({ status = 200, headers = {}, body = '{"ok":true,"items":[]}', error = false } = {}) {
  const calls: { url: string; method: string; headers: Record<string,string>; body: unknown }[] = [];
  const request = (url: string, opts: any, callback: any) => {
    const req: any = new EventEmitter(); req.destroy = () => {};
    req.end = (input: unknown) => {
      calls.push({ url, ...opts, body: input });
      queueMicrotask(() => {
        if (error) return req.emit('error', new Error('transport-private-error'));
        const res: any = new EventEmitter(); res.statusCode = status; res.headers = headers; res.destroy = () => {};
        callback(res); res.emit('data', Buffer.from(body)); res.emit('end');
      });
    };
    return req;
  };
  return { calls, request };
}
const event = { httpMethod:'POST', path:'/public-api', headers:{ Authorization:secret,'Content-Type':'application/json',Cookie:'private-cookie','X-WX-OPENID':'private-id' }, body:'{"operation":"tripList"}' };
test('old public URL forwards only bounded read body and bearer to the fixed backend', async () => {
  const t = transport(); const relay = createLegacyPublicRelay('public-web',t);
  const r = await relay(event); assert.equal(r.statusCode,200);
  assert.equal(t.calls.length,1); const call=t.calls[0]!;
  assert.equal(call.url,'https://collect.linkx.ink/api/v1/compat/public-web');
  assert.deepEqual(call.headers,{'content-type':'application/json','content-length':String(Buffer.byteLength(event.body)),authorization:secret});
  assert.equal(String(call.body),event.body);
  await relay({...event,isBase64Encoded:true,body:Buffer.from(event.body).toString('base64')});
  assert.equal(String(t.calls[1]!.body),event.body);
});
test('old writers and malformed public envelopes never reach a network or database', async () => {
  const t=transport(); const relay=createLegacyPublicRelay('public-web',t);
  assert.equal((await relay({action:'create',data:{}})).code,'MAINTENANCE');
  assert.equal((await relay({...event,path:'/admin/login'})).statusCode,503);
  for(const bad of [{...event,rawPath:'/private'}, {...event,httpMethod:'DELETE'},
    {...event,headers:{...event.headers,authorization:secret}}, {...event,headers:{...event.headers,Authorization:'bad'}},
    {...event,body:'x'.repeat(3000)}, {...event,isBase64Encoded:true,body:'%%%'}]) assert.ok((await relay(bad)).statusCode>=400);
  assert.equal(t.calls.length,0);
});
test('house-share forwards only known query and origin and retains CORS response', async () => {
  const t=transport({status:204,body:'',headers:{'access-control-allow-origin':'https://site.example','set-cookie':'forbidden'}});
  const relay=createLegacyPublicRelay('house-share',t);
  const r=await relay({httpMethod:'OPTIONS',headers:{Origin:'https://site.example',Authorization:'private'},queryStringParameters:{operation:'marketList',limit:'10'}});
  assert.equal(r.statusCode,204);assert.equal(r.body,'');assert.equal(r.headers['set-cookie'],undefined);
  assert.equal(r.headers['access-control-allow-origin'],'https://site.example');
  assert.equal(t.calls[0]!.url,'https://collect.linkx.ink/api/v1/compat/house-share?operation=marketList&limit=10');
  assert.deepEqual(t.calls[0]!.headers,{accept:'application/json',origin:'https://site.example'});
  assert.equal((await relay({httpMethod:'GET',headers:{},rawQueryString:'id=a&id=b'})).statusCode,400);
  assert.equal((await relay({httpMethod:'GET',headers:{},queryStringParameters:{url:'https://elsewhere'}})).statusCode,400);
  assert.equal(t.calls.length,1);
});
test('upstream failures, redirects, non-JSON and oversized responses fail without legacy write fallback', async () => {
  for(const input of [{error:true},{status:302},{body:'private-error-text'},{body:'x'.repeat(512*1024+1)},{headers:{'content-encoding':'gzip'}}]) {
    const t=transport(input); const r=await createLegacyPublicRelay('public-web',t)(event);
    assert.equal(r.statusCode,503);assert.deepEqual(JSON.parse(r.body),{ok:false,error:'service_unavailable'});assert.equal(t.calls.length,1);
  }
});
