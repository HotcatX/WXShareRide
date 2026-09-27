const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {resolve,reject,promise} }
function harness(options={}) {
 const storage={openid:'synthetic_a',isGuest:false};const state={gets:[],mutations:[],cloud:[],toasts:[],navigation:[],badges:[],sets:[],refreshes:0,modal:null}
 let items=[{id:'a',title:'A',content:'one',type:'rating_invitation',rideId:'ride_a',createdAt:'2026-09-26T12:00:00.000001Z',read:false},{id:'b',title:'B',content:'two',type:'RATING_INVITE',rideId:'legacy_ride',createdAt:'2026-09-25T12:00:00.000001Z',read:false}]
 const wx={getStorageSync:key=>storage[key],setStorageSync:(key,value)=>{storage[key]=value;state.badges.push(value)},getWindowInfo:()=>({statusBarHeight:24}),
  showToast:input=>state.toasts.push(input.title),showModal:input=>{state.modal=input},navigateTo:input=>state.navigation.push(input.url),navigateBack(){},stopPullDownRefresh(){},
  cloud:options.cloud||{database(){state.cloud.push('database');throw Error('legacy DB forbidden')},callFunction(){state.cloud.push('function');throw Error('legacy cloud forbidden')}}}
 const backend={isBackendEnabled:()=>options.server!==false,retryCloudPending:async()=>null,get:async url=>{state.gets.push(url);return {items,nextCursor:null,unreadCount:102}},
  mutate:async(...args)=>{state.mutations.push(plain(args));return {}},...options.backend}
 const apiModule={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/compat/notifications.js'),'utf8'),{module:apiModule,wx,require:name=>name==='../backendClient'?backend:require('../utils/hash')})
 let definition;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/profile/notification/notification.js'),'utf8'),{wx,Page:page=>{definition=page},getCurrentPages:()=>[{loadUnreadCount(){state.refreshes++}},{}],require:()=>apiModule.exports})
 const page={...definition,data:plain(definition.data)};page.setData=patch=>{state.sets.push(plain(patch));Object.assign(page.data,plain(patch))};page.onLoad()
 return {page,api:apiModule.exports,wx,backend,storage,state,setItems:value=>{items=value}}
}
const event=(id,index=0)=>({currentTarget:{dataset:{id,index,tripid:'forged'}}})
test('server list uses canonical route and full unread total beyond first page, without any CloudBase call',async()=>{
 const h=harness();await h.page.onShow();assert.deepEqual(h.state.gets,['/api/v1/notifications?limit=100'])
 assert.equal(h.page.data.list.length,2);assert.equal(h.page.data.unreadCount,102);assert.equal(h.storage.customTabProfileBadge,102)
 assert.deepEqual(h.state.cloud,[]);assert.ok(h.page.data.list.every(item=>item.canRate));assert.match(h.page.data.list[0].createdAtText,/2026-/)
})
test('single read uses notification ID, not stale dataset index, and refreshes authoritative unread count',async()=>{
 const h=harness();await h.page.loadList();await h.page.onTapItem(event('b',0))
 const [scope,method,url,body]=h.state.mutations[0];assert.equal(scope,'notifications.read:b');assert.equal(method,'POST');assert.equal(url,'/api/v1/notifications/b/read');assert.deepEqual(body,{})
 assert.equal(h.state.gets.length,2);assert.equal(h.page.data.list[0].read,false);assert.equal(h.page.data.unreadCount,102)
})
test('canonical and imported rating invitations use their stored ride ID for the original history page',async()=>{
 const h=harness();await h.page.loadList();await h.page.onGoRating(event('a',1));await h.page.onGoRating(event('b',0))
 assert.deepEqual(h.state.navigation,['/pages/profile/tripHistory/tripHistory?rateTripId=ride_a','/pages/profile/tripHistory/tripHistory?rateTripId=legacy_ride'])
})
test('read-all/clear refresh retain notifications that arrive after each transaction',async()=>{
 const h=harness();await h.page.loadList();h.backend.mutate=async(...args)=>{h.state.mutations.push(plain(args));h.setItems([{id:'new',type:'fixture',title:'New',content:'new arrival',read:false,createdAt:new Date().toISOString()}])}
 await h.page.onMarkAllRead();assert.equal(h.page.data.list[0]._id,'new');assert.equal(h.page.data.unreadCount,102)
 h.page.onDeleteAll();assert.match(h.state.modal.content,/不可恢复/);await h.state.modal.success({confirm:true})
 assert.equal(h.page.data.list[0]._id,'new');assert.equal(h.storage.customTabProfileBadge,102)
 assert.deepEqual(h.state.mutations.map(x=>x.slice(0,3)),[['notifications.readAll','POST','/api/v1/notifications/read-all'],['notifications.clear','DELETE','/api/v1/notifications']])
 assert.equal(h.state.refreshes,2)
})
test('late list responses cannot overwrite the most recent refresh',async()=>{
 const one=deferred(),two=deferred();let count=0;const h=harness({backend:{get:()=>++count===1?one.promise:two.promise}})
 const first=h.page.loadList(),second=h.page.loadList();two.resolve({items:[],nextCursor:null,unreadCount:3});await second
 one.resolve({items:[{id:'old',read:false}],nextCursor:null,unreadCount:99});await first
 assert.deepEqual(h.page.data.list,[]);assert.equal(h.storage.customTabProfileBadge,3)
})
test('account switch hides old rows immediately; old loads and delayed modal confirmations do nothing',async()=>{
 const h=harness();await h.page.loadList();h.page.onDeleteAll();const oldModal=h.state.modal
 const hold=deferred();h.backend.get=()=>hold.promise;const first=h.page.loadList();h.storage.openid='synthetic_b';const second=h.page.loadList()
 assert.deepEqual(h.page.data.list,[]);await oldModal.success({confirm:true});assert.equal(h.state.mutations.length,0)
 hold.resolve({items:[],nextCursor:null,unreadCount:5});await Promise.all([first,second]);assert.equal(h.page.data.unreadCount,5)
})
test('old account and unloaded mutation completions cannot navigate, update rows or badges',async()=>{
 for(const unload of [false,true]){
  const h=harness();await h.page.loadList();const hold=deferred();h.backend.mutate=()=>hold.promise
  const pending=h.page.onGoRating(event('a'));const writes=h.state.sets.length
  if(unload)h.page.onUnload();else h.storage.openid='synthetic_b'
  hold.resolve({id:'a',read:true});await pending
  assert.equal(h.state.navigation.length,0);assert.equal(h.state.sets.length,writes);assert.equal(h.state.refreshes,0)
 }
})
test('server errors and malformed responses leave data intact and never invoke legacy writes',async()=>{
 const h=harness();await h.page.loadList();h.backend.mutate=async()=>{throw Error('synthetic timeout')}
 await h.page.onMarkAllRead();h.page.onDeleteAll();await h.state.modal.success({confirm:true});await h.page.onTapItem(event('a'))
 assert.equal(h.page.data.list.length,2);assert.equal(h.page.data.unreadCount,102);assert.equal(h.state.cloud.length,0)
 h.backend.get=async()=>({items:[],nextCursor:null,unreadCount:'0'});await h.page.loadList();assert.equal(h.page.data.list.length,2)
})
test('concurrent taps share the page operation guard; unload suppresses late load updates',async()=>{
 const h=harness();await h.page.loadList();const hold=deferred();let calls=0;h.backend.mutate=()=>{calls++;return hold.promise}
 const first=h.page.onTapItem(event('a'));await h.page.onTapItem(event('a'));assert.equal(calls,1)
 h.page.onUnload();const count=h.state.sets.length;hold.resolve({});await first;assert.equal(h.state.sets.length,count)
})
test('guest and stale IDs cannot write or navigate, and invalid times stay empty',async()=>{
 const h=harness();await h.page.loadList();await h.page.onTapItem(event('missing'));assert.equal(h.state.mutations.length,0)
 h.storage.isGuest=true;await h.page.onGoRating(event('a'));await h.page.loadList();assert.equal(h.state.mutations.length,0);assert.equal(h.state.navigation.length,0)
 assert.equal(h.page.data.unreadCount,0);assert.equal(h.page.formatTime('invalid'),'')
})
test('CloudBase mode uses narrow backend actions for list/read/readAll/clear and never client database writes',async()=>{
 const calls=[]
 const h=harness({server:false,backend:{
  cloudRead:async(action)=>{calls.push([action]);return {items:[{_id:'legacy',_openid:'synthetic_a',type:'RATING_INVITE',extra:{requestId:'old_trip'},read:false,createdAt:0}],unreadCount:101}},
  cloudMutate:async(scope,action,body)=>{calls.push([action,plain(body)]);return action==='notifications.read'?{id:body.id,read:true}:action==='notifications.readAll'?{changed:101}:{deleted:101}}
 }})
 await h.page.loadList();assert.equal(h.page.data.list[0].rateTripId,'old_trip');assert.equal(h.page.data.unreadCount,101)
 await h.api.markRead('legacy');await h.api.markAllRead();await h.api.clear()
 assert.deepEqual(calls,[['notifications.list'],['notifications.read',{id:'legacy'}],['notifications.readAll',{}],['notifications.clear',{}]])
 assert.equal(h.state.cloud.length,0);assert.equal(h.state.mutations.length,0)
})

module.exports={harness}

test('real SDK + PostgreSQL: lost read-all/clear ACK replays preserve later arrivals, ownership and true badge count', {skip:!process.env.BACKEND_TEST_DATABASE_URL}, async t=>{
 const [{createApp},{createTestDatabase}]=await Promise.all([import('../services/backend/src/app.ts'),import('../services/backend/test/helpers/database.ts')])
 const {createBackendClient}=require('../utils/backendClient')
 const db=await createTestDatabase(), appId='notification-client-test',openid='notifications_client_synthetic_user'
 const app=await createApp({pool:db.pool,config:{databaseUrl:'',host:'127.0.0.1',port:3100,appId,businessMode:'active',sessionTtlSeconds:3600},exchange:async()=>({openid})})
 t.after(async()=>{await app.close();await db.close()})
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{code:'synthetic-code'}})
 assert.equal(login.statusCode,200);const userId=login.json().data.user.id
 const other=(await db.pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id',[appId,'notification_other_synthetic_user'])).rows[0].id
 const add=(id,owner=userId)=>db.pool.query("INSERT INTO notifications(id,user_id,type,title,content) VALUES($1,$2,'fixture','Synthetic notice','test')",[id,owner])
 for(let i=0;i<102;i++)await add(`initial_${i}`)
 await add('foreign',other)
 const h=harness();h.storage.openid=openid
 let lose='',afterCommit=null;const writes=[]
 h.wx.removeStorageSync=key=>{delete h.storage[key]}
 h.wx.cloud.callFunction=async options=>{assert.equal(options.name,'backend');assert.deepEqual(options.data,{action:'login'});return {result:login.json()}}
 h.wx.request=options=>{
  const url=new URL(options.url).pathname+new URL(options.url).search
  app.inject({method:options.method,url,headers:options.header,payload:options.data}).then(async response=>{
   if(options.method!=='GET')writes.push({url,key:options.header['Idempotency-Key']})
   if(lose===url){lose='';if(afterCommit)await afterCommit();options.fail({errMsg:'synthetic lost ACK'})}
   else options.success({statusCode:response.statusCode,data:response.json()})
  },()=>options.fail({errMsg:'injection failed'}))
  return {abort(){}}
 }
 Object.assign(h.backend,createBackendClient({wx:h.wx,config:{mode:'server',origin:'https://collect.linkx.ink'}}))
 await h.page.loadList();assert.equal(h.page.data.list.length,100);assert.equal(h.page.data.unreadCount,102)
 lose='/api/v1/notifications/read-all';afterCommit=()=>add('after_read')
 await h.page.onMarkAllRead();await h.page.onMarkAllRead()
 assert.equal(writes[0].key,writes[1].key);assert.equal(h.page.data.unreadCount,1);assert.equal(h.storage.customTabProfileBadge,1)
 assert.equal(h.page.data.list.find(row=>row._id==='after_read').read,false)
 lose='/api/v1/notifications';afterCommit=()=>add('after_clear')
 h.page.onDeleteAll();await h.state.modal.success({confirm:true});h.page.onDeleteAll();await h.state.modal.success({confirm:true})
 assert.equal(writes[2].key,writes[3].key);assert.deepEqual(h.page.data.list.map(row=>row._id),['after_clear']);assert.equal(h.page.data.unreadCount,1)
 assert.equal((await db.pool.query('SELECT count(*) FROM notifications WHERE user_id=$1',[other])).rows[0].count,'1')
 await h.page.onTapItem(event('after_clear'));assert.equal(h.page.data.unreadCount,0)
})
