const test=require('node:test'),assert=require('node:assert/strict')
const {createCompatHandler,userId}=require('../cloudfunctions/backend/compat')
const {createBackendClient,PENDING_KEY,SESSION_KEY}=require('../utils/backendClient')
const {createRideTemplateClient}=require('../utils/compat/rideTemplates')
const makeStore=require('./helpers/cloud-transaction-store.cjs')
const appId='wx8a8a389199aa2a0e',openid='synthetic-transition-owner'
const form={templateName:'周二上课',departureAddress:'Fort Lee',destinationAddress:'哥大',weekdayIndex:1,weekdayText:'周二',departureTime:'15:00',passengerCount:3,referencePrice:'11-13$',comment:''}
function harness(){
 const store=makeStore(), handler=createCompatHandler({getDb:()=>store.db}), storage={openid,isGuest:false},calls=[]
 const state={drop:false,malformed:false,identity:openid,hold:null,holdAction:null}
 const context=()=>({environment:JSON.stringify({TCB_SOURCE:'wx_client',WX_APPID:appId,WX_OPENID:state.identity})})
 const wx={getStorageSync:key=>structuredClone(storage[key]),setStorageSync:(key,value)=>{storage[key]=structuredClone(value)},removeStorageSync:key=>{delete storage[key]},
 cloud:{async callFunction({name,data}){if(name==='login')return {result:{ok:true,openid:state.identity}};assert.equal(name,'backend');calls.push(structuredClone(data));const result=await handler(data,context());
 if(data.key&&result.ok&&state.drop){state.drop=false;throw Error('lost ack')}
 if(data.key&&result.ok&&state.malformed){state.malformed=false;result.data={bad:true}}
 if(state.hold && (!state.holdAction || state.holdAction===data.action))await state.hold
 return {result:JSON.parse(JSON.stringify(result))}},database(){throw Error('No client DB')}},request(){throw Error('No PG HTTP')}}
 const make=()=>createBackendClient({wx,config:{mode:'cloudbase'}})
 return {store,storage,state,calls,wx,make,client:make(),invoke:(action,body={},key)=>handler({action,body,expectedOpenid:state.identity,...(key?{key}:{})},context())}
}
test('actual SDK and cloud handler persist original template intent atomically across lost ACK/restart and edited form',async()=>{
 const h=harness();let client=h.client,api=createRideTemplateClient({wx:h.wx,backend:client})
 h.state.drop=true;await assert.rejects(api.saveRideTemplate(form),{code:'NETWORK_ERROR'})
 assert.equal(h.store.all('CarpoolTemplate').length,1);assert.equal(h.store.all('OperationReceipts').length,1)
 const original=h.calls.find(x=>x.key);assert.equal(h.storage[SESSION_KEY],undefined)
 client=h.make();api=createRideTemplateClient({wx:h.wx,backend:client})
 await assert.rejects(api.saveRideTemplate({...form,departureTime:'16:00'}),{code:'PENDING_OPERATION'})
 const recovered=await api.recoverRideTemplate();assert.equal(recovered.departureTime,'15:00')
 const replay=h.calls.filter(x=>x.key).at(-1);assert.deepEqual(replay,original)
 await api.saveRideTemplate({...form,departureTime:'16:00'},{id:recovered._id})
 assert.equal(h.store.all('CarpoolTemplate').length,1);assert.equal(h.store.all('CarpoolTemplate')[0].departureTime,'16:00')
 assert.equal(h.storage[PENDING_KEY],undefined);assert.equal(h.storage.openid,openid)
 assert.equal((await api.loadRideTemplates()).length,1)
 assert.equal((await api.getRideTemplate(recovered._id))._id,recovered._id)
 await api.deleteRideTemplate(recovered._id);assert.equal(h.store.all('CarpoolTemplate').length,0)
 const receipt=h.store.all('OperationReceipts')[0];assert.deepEqual(receipt.payload,{form});assert.equal(receipt.key,original.key);assert.equal(receipt.openid,openid)
})
test('cloud ownership, allowlisted fields/actions and transactional receipt failure stop unauthorized or partial mutations',async()=>{
 const h=harness();h.store.seed('CarpoolTemplate','foreign',{...form,_openid:'another-owner'})
 for(const action of ['templates.get','templates.delete','templates.update']){
 const result=await h.invoke(action,{id:'foreign',...(action.endsWith('update')?{form}:{})},action==='templates.get'?undefined:'ownership-key')
 assert.equal(result.ok,false);assert.equal(result.error.status,404)
 }
 for(const [action,body] of [['unknown.collection',{}],['templates.create',{form:{...form,_openid:'spoof'}}],['profile.spots.add',{field:'phone',value:'bad'}]])assert.equal((await h.invoke(action,body,'rejected-operation')).ok,false)
 h.store.state.beforeCommit=()=>{throw Error('receipt storage unavailable')}
 assert.equal((await h.invoke('templates.create',{form},'atomic-failure-key')).ok,false)
 assert.equal(h.store.all('CarpoolTemplate').length,1);assert.equal(h.store.all('OperationReceipts').length,0)
 h.store.state.beforeCommit=null
 const replies=await Promise.all([h.invoke('templates.create',{form},'same-concurrent-key'),h.invoke('templates.create',{form},'same-concurrent-key')])
 assert.equal(replies[0].data._id,replies[1].data._id)
 assert.equal((await h.invoke('templates.create',{form:{...form,comment:'changed'}},'same-concurrent-key')).error.code,'IDEMPOTENCY_CONFLICT')
})
test('427-notification bulk freezes exact targets and resumes batches without consuming new arrivals',async()=>{
 for(const action of ['notifications.readAll','notifications.clear']){
 const h=harness();for(let i=0;i<427;i++)h.store.seed('Notifications',`notice-${String(i).padStart(4,'0')}`,{_openid:openid,read:false,createdAt:new Date()})
 h.store.seed('Notifications','foreign',{_openid:'other',read:false})
 let failures=1
 h.store.state.beforeCommit=(snapshot)=>{const receipt=[...snapshot.values()].find(row=>row.action===action)
 if(receipt?.offset===80&&failures-- >0)throw Error('process interrupted')}
 const first=await h.invoke(action,{},'frozen-bulk-key');assert.equal(first.ok,false)
 assert.equal(h.store.all('OperationReceipts')[0].offset,40)
 h.store.seed('Notifications','arrived-after-freeze',{_openid:openid,read:false,createdAt:new Date()})
 h.store.state.beforeCommit=null
 const retry=await h.invoke(action,{},'frozen-bulk-key');assert.equal(retry.ok,true);assert.deepEqual(retry.data,{[action.endsWith('clear')?'deleted':'changed']:427})
 assert.deepEqual((await h.invoke(action,{},'frozen-bulk-key')).data,retry.data)
 const remaining=h.store.all('Notifications');assert.equal(remaining.find(x=>x._id==='arrived-after-freeze').read,false);assert.equal(remaining.find(x=>x._id==='foreign').read,false)
 assert.ok(h.store.state.operations.every(n=>n<=100));assert.equal(h.store.all('OperationReceipts')[0].state,'completed')
 }
})
test('spot mutations use verified owner and replay exact old reply without reapplying to newer profile state',async()=>{
 const h=harness();h.store.seed('userInfo','self',{_openid:openid,pickupSpot:['Fort Lee']})
 const add={field:'pickupSpot',value:'JFK'}
 assert.deepEqual((await h.invoke('profile.spots.add',add,'original-add-key')).data.values,['Fort Lee','JFK'])
 assert.deepEqual((await h.invoke('profile.spots.remove',add,'remove-spot-key')).data.values,['Fort Lee'])
 assert.deepEqual((await h.invoke('profile.spots.add',add,'original-add-key')).data.values,['Fort Lee','JFK'])
 assert.deepEqual(h.store.all('userInfo')[0].pickupSpot,['Fort Lee'])
})
test('cloud address lists share the canonical twenty-address limit without dropping data or saving rejected receipts',async()=>{
 const h=harness(),values=Array.from({length:19},(_,index)=>`Address ${index+1}`)
 h.store.seed('userInfo','self',{_openid:openid,pickupSpot:values})
 const last={field:'pickupSpot',value:'Address 20'}
 assert.equal((await h.invoke('profile.spots.add',last,'address-twenty')).data.values.length,20)
 assert.equal((await h.invoke('profile.spots.add',last,'address-repeat')).data.values.length,20)
 const rejected=await h.invoke('profile.spots.add',{field:'pickupSpot',value:'Address 21'},'address-over-limit')
 assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'TOO_MANY_ADDRESSES')
 assert.deepEqual(h.store.all('userInfo')[0].pickupSpot,[...values,'Address 20'])
 assert.equal(h.store.all('OperationReceipts').length,2)
 assert.equal((await h.invoke('profile.spots.remove',last,'address-remove')).data.values.length,19)
 assert.equal((await h.invoke('profile.spots.add',{field:'pickupSpot',value:'Address 21'},'address-over-limit')).data.values.length,20)
})
test('cloud SDK retains malformed ACK and old keys on later 403, rejects account changes and does not create PG sessions',async()=>{
 const h=harness(),options={validate:row=>row&&typeof row._id==='string'}
 h.state.malformed=true;await assert.rejects(h.client.cloudMutate('templates.create','templates.create',{form},options),{code:'INVALID_RESPONSE'})
 const pending=structuredClone(h.storage[PENDING_KEY])
 h.state.identity='synthetic-different-owner';await assert.rejects(h.make().retryCloudPending('templates.create',options),{code:'IDENTITY_CHANGED'})
 assert.deepEqual(h.storage[PENDING_KEY],pending)
 h.state.identity=openid;assert.ok((await h.make().retryCloudPending('templates.create',options))._id)
 assert.equal(h.storage[SESSION_KEY],undefined);assert.equal(h.storage[PENDING_KEY],undefined)
 await assert.rejects(h.client.cloudMutate('unknown','arbitrary',{}),{code:'INVALID_REQUEST'})
 const actor=userId({appId,openid});assert.match(actor,/^[a-f0-9-]{36}$/)
})

test('logout and trusted CloudBase re-login cancel late identity/read/write ACKs even for the same OpenID',async()=>{
 for(const action of ['identity','notifications.unread','templates.create']){
  const h=harness();let release;h.state.hold=new Promise(resolve=>{release=resolve});h.state.holdAction=action
  const pending=action==='notifications.unread'?h.client.cloudRead(action):h.client.cloudMutate('templates.create','templates.create',{form},{validate:row=>row&&row._id})
  // Wait until the specific response is held, including the write after its identity read.
  while(!h.calls.some(call=>call.action===action))await new Promise(resolve=>setImmediate(resolve))
  await h.client.logout();await assert.rejects(h.client.cloudRead('notifications.unread'),{code:'UNAUTHORIZED'});h.storage.isGuest=true;h.storage.openid=''
  assert.equal((await h.client.cloudLogin()).result.openid,openid)
  h.storage.openid=openid;h.storage.isGuest=false;release()
  await assert.rejects(pending,{code:'REQUEST_CANCELLED'})
  h.state.hold=null
  assert.equal((await h.client.cloudRead('notifications.unread')).unreadCount,0)
  assert.equal(h.storage[SESSION_KEY],undefined)
  if(action==='templates.create')assert.ok(h.storage[PENDING_KEY]?.length)
  else assert.equal(h.store.all('CarpoolTemplate').length,0)
 }
})
