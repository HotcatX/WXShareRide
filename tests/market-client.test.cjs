const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const loadMarket = require('./helpers/market-api.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333']
function harness(overrides = {}) {
  const store = { openid: 'synthetic_market_client', isGuest: false }, calls = []
  const wx = { getStorageSync:key=>store[key],setStorageSync:(key,value)=>{store[key]=value},removeStorageSync:key=>{delete store[key]},
    cloud:{callFunction(){assert.fail('server mode must never use legacy cloud functions')},getTempFileURL(){assert.fail('no cloud image resolver')},uploadFile(){assert.fail('no cloud upload')}} }
  const backend = { ready:async()=>'server', isBackendEnabled:()=>true, retryPending:async()=>null,
    get:async(url,options)=>{calls.push(['get',url,options]);return {items:[],hasMore:false,nextOffset:0}},
    resolveImages:async(fileIds,options)=>{calls.push(['images',fileIds,options]);return fileIds.map(fileId=>({fileId,url:`https://images.example.test/${fileId}?signed=1`}))},
    mutate:async(...args)=>{calls.push(['mutate',...args.slice(0,4)]);return {id:'listing',version:1,status:'online'}},...overrides }
  const api = loadMarket(wx,backend)
  return {api,wx,backend,store,calls}
}
function fixture(extra={}) {
  return {id:'listing',listingType:'goods',title:'Chair',description:'A chair',priceCents:1234,category:'家具',condition:'全新',
    region:{state:'NY_NJ',county:'Bergen',area:'Fort Lee'},buildingName:'Building',location:null,
    startDate:'2026-09-26',endDate:'2026-10-10',expiresAt:'2026-10-11T03:59:59Z',createdAt:'2026-09-26T12:00:00Z',
    status:'online',version:3,isOwner:true,viewCount:4,images:[{fileId:ids[0]},{fileId:ids[1],thumbFileId:ids[2]}],
    seller:{userId:ids[0],kind:'user',name:'Seller',avatarFileId:null,regionLabel:'Fort Lee',residence:'Building',bio:'Bio',wechatId:'seller-contact',phone:''},...extra}
}
function draft(extra={}) {
  return {listingType:'goods',title:'Chair',desc:'A chair',price:'12.34',category:'家具',condition:'全新',regionState:'NY_NJ',regionCounty:'Bergen',regionArea:'Fort Lee',
    pickupStartDate:'2026-09-26',pickupEndDate:'2026-10-10',imageFileIDs:[ids[0],ids[1]],thumbFileIDs:['',ids[2]],...extra}
}
test('server market list maps strict filters/pagination and UUID image slots without making an OpenID',async()=>{
  const h=harness();h.backend.get=async(url,options)=>{h.calls.push(['get',url,options]);return {items:[fixture()],hasMore:true,nextOffset:20}}
  const response=await h.api.call({data:{action:'list',skip:0,limit:20,filters:{listingType:'goods',category:'全部',cityKey:'ALL',regionKeys:['legacy'],keyword:'chair'},sort:{by:'distance',origin:{lat:40,lng:-74}}}})
  const url=new URL(h.calls[0][1],'https://example.test');assert.equal(url.searchParams.get('sort'),'distance');assert.equal(url.searchParams.get('latitude'),'40')
  for(const key of ['category','cityKey','regionKeys'])assert.equal(url.searchParams.has(key),false)
  const item=response.result.items[0];assert.equal(item.price,12.34);assert.deepEqual(plain(item.thumbFileIDs),['',ids[2]])
  assert.equal(item.sellerId,ids[0]);assert.equal(Object.hasOwn(item,'_openid'),false);assert.equal(item.isOwner,true);assert.equal(item.version,3)
  assert.equal(response.result.nextSkip,20);assert.match(item.imageUrls[0],/^https:/)
})
test('canonical writes whitelist content, retain contact snapshot and image pairing, reject fractional cents',async()=>{
  const h=harness(),input=draft({sellerContact:{name:'Managed contact',wechat:'contact',phone:'',avatar:'',note:''},status:'online',clientRequestId:'old',expireTime:1})
  const result=h.api.content(input);assert.equal(result.priceCents,1234);assert.deepEqual(plain(result.images),[{fileId:ids[0]},{fileId:ids[1],thumbFileId:ids[2]}])
  for(const key of ['status','clientRequestId','expireTime','imageFileIDs'])assert.equal(Object.hasOwn(result,key),false)
  assert.equal(result.sellerContact.wechat,'contact');for(const price of ['-1','1.001','NaN'])assert.throws(()=>h.api.content(draft({price})),{code:'INVALID_PRICE'})
  await h.api.call({data:{action:'update',id:'listing',expectedVersion:3,patch:input}})
  const mutation=h.calls.find(row=>row[0]==='mutate');assert.equal(mutation[1],'market.update:listing');assert.equal(mutation[4].expectedVersion,3)
})
test('guest and managed seller projections never fabricate ownership, profile identity or contact',async()=>{
  const h=harness();const guest=h.api.item(fixture({seller:undefined,isOwner:undefined,version:undefined,region:{state:'NY_NJ'}}))
  assert.equal(guest.seller,null);assert.equal(guest.sellerId,'');assert.equal(guest.isOwner,false);assert.equal(guest.sellerWechat,'')
  const managed=h.api.item(fixture({seller:{kind:'managed',userId:ids[0],name:'Per listing',avatarFileId:null,wechatId:'agent'}}))
  assert.equal(managed.managedByAdmin,true);assert.equal(managed.seller.name,'Per listing');assert.equal(managed.sellerWechat,'agent')
})
test('malformed or failed backend reads never call CloudBase; old buy history is explicitly unavailable',async()=>{
  const h=harness({get:async()=>{throw Object.assign(Error('timeout'),{code:'NETWORK_ERROR'})}})
  await assert.rejects(h.api.call({data:{action:'list'}}),{code:'NETWORK_ERROR'})
  await assert.rejects(h.api.call({data:{action:'tradeList',type:'bought'}}),{code:'TRADE_UNAVAILABLE'})
})
test('an uncertain create is reconciled as the original intent, never reported as saving a newly edited form',async()=>{
  const h=harness({retryPending:async()=>({id:'original',version:0,status:'online'})})
  const result=await h.api.call({data:{action:'create',payload:draft({title:'New unsent title'})}})
  assert.equal(result.result.id,'original');assert.equal(result.result.recovered,true);assert.equal(h.calls.length,0)
})
test('signed links refresh when pages return/linger; hidden/unloaded and old-account writes are guarded',async()=>{
  const h=harness();let next=0;const timers=new Map(),updates=[],api=loadMarket(h.wx,h.backend,{setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:id=>timers.delete(id)})
  const definition=api.page({data:{text:''},onLoad(){this.setData({text:'loaded'})},refreshMarketImages(){updates.push('refresh')}})
  const page={...definition,data:{text:''},setData(patch){Object.assign(this.data,patch);updates.push(patch)}};page.onLoad({});page.onShow()
  assert.equal(timers.size,1);timers.values().next().value();assert.ok(updates.includes('refresh'));page.onHide();assert.equal(timers.size,0)
  h.store.openid='another';page.setData({text:'old'});assert.equal(page.data.text,'loaded');page.onShow();assert.equal(page.data.text,'loaded')
  page.onUnload();page.setData({text:'late'});assert.equal(page.data.text,'loaded');assert.equal(timers.size,0)
})
function loadHelper(file,wx,backend) {
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils',file),'utf8'),{module,wx,Date,setTimeout,clearTimeout,
    require:name=>name==='./backendClient'?backend:name==='./rideTime'?require('../utils/rideTime'):name==='./cityTree'?require('../utils/cityTree'):{isTimelinePreview:()=>false}});return module.exports
}
test('public market and ride previews force anonymous transport and expose only formatted public fields',async()=>{
  const h=harness();h.backend.get=async(url,options)=>{h.calls.push(['get',url,options]);return url.includes('/previews/rides')?
    {id:'ride',kind:'offer',departureAt:'2026-10-01T19:00:00Z',fromArea:'Fort Lee',toArea:'Columbia University',listedPriceCents:1000,availableSeats:2,privateMarker:'must not copy'}:fixture()}
  const api=loadHelper('publicPreview.js',h.wx,h.backend)
  const item=(await api.callPublicPreview({action:'marketDetail',id:'listing'})).item;assert.equal(item.priceText,'$12.34');assert.equal(item.images.length,2);assert.equal(Object.hasOwn(item,'seller'),false)
  const trip=(await api.callPublicPreview({action:'tripDetail',id:'ride'})).item;assert.equal(trip.kind,'carpool');assert.equal(trip.timeText,'2026-10-01 15:00');assert.equal(JSON.stringify(trip).includes('privateMarker'),false)
  assert.ok(h.calls.every(row=>row[0]==='get'?row[2].anonymous===true:row[2].anonymous===true))
})
test('community ISO clocks and UUID images preserve manual availability while the automatic switch is off',async()=>{
  const h=harness();h.backend.get=async()=>({serverTime:'2026-09-27T12:00:00Z',group:{enabled:true,title:'Group',imageFileId:ids[0],expiresAt:'2026-09-28T12:00:00Z'},
    announcement:{available:true,enabled:false,id:'notice',title:'Notice',body:'Welcome',imageFileId:ids[0],maxShows:1,intervalHours:24,startAt:null,endAt:null}})
  const api=loadHelper('community.js',h.wx,h.backend),data=await api.loadCommunityConfig();assert.equal(data.serverTime,Date.parse('2026-09-27T12:00:00Z'))
  assert.match(data.group.imageUrl,/https:/);assert.equal(api.getAvailableAnnouncement(data).enabled,false);assert.equal(data.announcement.startAt,0)
})

function loadPage(file,h) {
  const filename=path.join(__dirname,'../pages/market',file),localRequire=require('node:module').createRequire(filename)
  let definition;vm.runInNewContext(fs.readFileSync(filename,'utf8'),{wx:h.wx,console:{error(){},warn(){}},setTimeout,clearTimeout,
    Page:value=>{definition=value},getApp:()=>({withReferralShare:value=>value}),getCurrentPages:()=>[{},{}],
    require:name=>name.endsWith('/compat/market')?h.api:name.endsWith('/marketSellerProfileCache')?{readMarketSellerProfile:()=>null,fetchAndCacheMarketSellerProfiles(){assert.fail('canonical seller must not query OpenIDs')}}:
      name.endsWith('/error')?{showDataError(){}}:localRequire(name)})
  const page={...definition,data:plain(definition.data),_marketOwner:h.api.identity()};page.setData=patch=>Object.assign(page.data,plain(patch));return page
}
test('editing retains the observed version, date window and a missing thumbnail slot all the way to PATCH',async()=>{
  const h=harness({get:async()=>fixture()});h.wx.showToast=()=>{};h.wx.navigateBack=()=>{}
  const page=loadPage('marketPost/marketPost.js',h);Object.assign(page.data,{isEdit:true,editId:'listing'})
  await page._loadExistingItem('listing');assert.equal(page.data.version,3);assert.equal(page.data.pickupStartDate,'2026-09-26')
  assert.deepEqual(page.data.thumbFileIDs,['',ids[2]]);assert.equal(page.data.thumbFileID,'');assert.equal(page.data.images.length,2)
  page.ensureLoginBeforePost=()=>true;page._getMyUserInfo=async()=>({wechatID:'seller-contact'});page._confirmPublishWithoutLocation=async()=>true;page._finishSubmitSuccess=()=>{}
  await page.onSubmit();const mutation=h.calls.find(row=>row[0]==='mutate');assert.ok(mutation);assert.equal(mutation[4].expectedVersion,3)
  assert.equal(mutation[4].patch.startDate,'2026-09-26');assert.deepEqual(plain(mutation[4].patch.images),[{fileId:ids[0]},{fileId:ids[1],thumbFileId:ids[2]}])
})
test('delete confirmation binds the observed ID/version and cannot execute after account change',async()=>{
  for(const switchAccount of [false,true]){
    const h=harness();let modal;h.wx.showModal=value=>{modal=value};h.wx.showToast=()=>{};h.wx.navigateBack=()=>{}
    h.backend.mutate=async(...args)=>{h.calls.push(['mutate',...args.slice(0,4)]);return {id:'listing',version:4,status:'deleted'}}
    const page=loadPage('marketDetail/marketDetail.js',h);Object.assign(page.data,{isOwner:true,item:{id:'listing',version:3}})
    const pending=page.onDeleteItem();page.data.item={id:'listing',version:9};if(switchAccount)h.store.openid='another'
    modal.success({confirm:true});await pending
    const mutation=h.calls.find(row=>row[0]==='mutate');if(switchAccount)assert.equal(mutation,undefined);else assert.equal(mutation[4].expectedVersion,3)
  }
})
test('main seller tap navigates by UUID and shared administrator sellers keep per-listing contact',()=>{
  const h=harness(),navigation=[],toasts=[];h.wx.navigateTo=value=>navigation.push(value.url);h.wx.showToast=value=>toasts.push(value.title)
  const page=loadPage('market.js',h);page.data.allGoods=[{id:'ordinary',sellerId:ids[0],managedByAdmin:false},{id:'managed',sellerId:ids[0],managedByAdmin:true}]
  page.onTapSeller({currentTarget:{dataset:{id:'ordinary',openid:'forged'}}});assert.match(navigation[0],new RegExp(`sellerId=${ids[0]}`));assert.equal(navigation[0].includes('openid='),false)
  page.onTapSeller({currentTarget:{dataset:{id:'managed',openid:'forged'}}});assert.equal(navigation.length,1);assert.deepEqual(toasts,['代发信息以详情为准'])
})
test('old city and seller shares still open anonymously without reconstructing private seller identity',async()=>{
  const h=harness();h.store.isGuest=true;h.wx.showToast=()=>assert.fail('a legacy seller share is still supported')
  h.backend.get=async(url,options)=>{h.calls.push(['get',url,options]);return {items:[],hasMore:false,nextOffset:0}}
  const previews=loadHelper('publicPreview.js',h.wx,h.backend)
  for(const [cityKey,state] of [['ny_nj','NY_NJ'],['boston','MA'],['bay_area','CA'],['WA','WA'],['all',null],['ALL_STATES',null]]){
    await previews.callPublicPreview({action:'marketList',cityKey})
    assert.equal(new URL(h.calls.at(-1)[1],'https://example.test').searchParams.get('regionState'),state)
    assert.equal(h.calls.at(-1)[2].anonymous,true)
  }
  const page=loadPage('marketSeller/marketSeller.js',h);page.data.sellerKey='legacy_openid'
  await page._loadServerSeller('legacy_openid')
  assert.match(h.calls.at(-1)[1],/^\/api\/v1\/market\/sellers\/legacy_openid\/listings\?/)
  assert.equal(page.data.sellerKey,'legacy_openid');assert.equal(page.data.hasGoods,false)
})
test('server photo selection bounds original/thumbnail dimensions before saving the exact retry bytes',async()=>{
  const h=harness(),compressed=[],saved=[]
  h.wx.chooseMedia=async()=>({tempFiles:[{tempFilePath:'phone.jpg'}]});h.wx.showToast=()=>{}
  h.wx.getImageInfo=({src,success})=>success(src==='phone.jpg'?{type:'jpg',width:4032,height:3024}:{type:'jpg',width:2048,height:1536})
  h.wx.compressImage=options=>{compressed.push(options);options.success({tempFilePath:`quality-${options.quality}.jpg`})}
  h.wx.getFileSystemManager=()=>({readFile:({success})=>success({data:new ArrayBuffer(10)})})
  h.wx.saveFile=({tempFilePath,success})=>{saved.push(tempFilePath);success({savedFilePath:`saved-${tempFilePath}`})}
  h.wx.removeSavedFile=()=>{}
  h.backend.uploadImage=async file=>({fileId:file.includes('52')?ids[0]:ids[1]})
  const page=loadPage('marketPost/marketPost.js',h);page.ensureLoginBeforePost=()=>true
  await page.onChooseImage()
  assert.deepEqual(compressed.map(row=>[row.compressedWidth,row.compressedHeight]),[[2048,1536],[512,384]])
  assert.deepEqual(saved,['quality-52.jpg','quality-42.jpg']);assert.deepEqual(page.data.imageFileIDs,[ids[0]]);assert.deepEqual(page.data.thumbFileIDs,[ids[1]])
})

test('real SDK and PostgreSQL: image/create/update/delete lost ACKs replay original keys and preserve UUID slot ownership', {skip:!process.env.BACKEND_TEST_DATABASE_URL},async t=>{
  const [{createApp},{createTestDatabase},{default:sharp}]=await Promise.all([import('../services/backend/src/app.ts'),import('../services/backend/test/helpers/database.ts'),Promise.resolve({default:require('node:module').createRequire(path.join(__dirname,'../services/backend/package.json'))('sharp')})])
  const {createBackendClient,PENDING_KEY}=require('../utils/backendClient');const db=await createTestDatabase(),objects=new Map();let puts=0
  const storage={bucket:'synthetic-market-123456',objects:{async put(locator,body,mediaType){puts++;if(!objects.has(locator))objects.set(locator,{body:Buffer.from(body),mediaType})},
    async read(locator){return objects.get(locator)||null}},async readUrl(file){return `https://images.example.test/${file.id}?signed=1`}}
  const app=await createApp({pool:db.pool,config:{databaseUrl:'',host:'127.0.0.1',port:3100,appId:'market-client-test',businessMode:'active',sessionTtlSeconds:3600},storage,exchange:async()=>({openid:'synthetic_market_client'})})
  t.after(async()=>{await app.close();await db.close()})
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{code:'synthetic'}});assert.equal(login.statusCode,200)
  const h=harness();let lose='',malformed='',clock=Date.now();const requests=[],fileBytes=new Map()
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:{r:30,g:60,b:90}}}).png().toBuffer()
  fileBytes.set('main',bytes);fileBytes.set('thumb',bytes)
  h.wx.cloud.callFunction=async request=>{assert.equal(request.name,'backend');return {result:login.json()}}
  h.wx.getFileSystemManager=()=>({readFile:({filePath,success,fail})=>{const data=fileBytes.get(filePath);data?success({data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)}):fail()}})
  h.wx.getImageInfo=({success})=>success({type:'png',width:4,height:4})
  h.wx.saveFile=({tempFilePath,success})=>{const saved=`saved-${tempFilePath}`;fileBytes.set(saved,Buffer.from(fileBytes.get(tempFilePath)));success({savedFilePath:saved})}
  h.wx.removeSavedFile=({filePath})=>fileBytes.delete(filePath)
  h.wx.request=options=>{const url=new URL(options.url),route=url.pathname+url.search;requests.push({route,key:options.header['Idempotency-Key'],method:options.method,authorization:options.header.Authorization})
    app.inject({method:options.method,url:route,headers:options.header,payload:options.data instanceof ArrayBuffer?Buffer.from(options.data):options.data}).then(response=>{
      if(lose===route){lose='';options.fail({})}else if(malformed===route){malformed='';options.success({statusCode:response.statusCode,data:{ok:true,data:{}}})}
      else options.success({statusCode:response.statusCode,data:response.json()})
    },()=>options.fail({}));return {abort(){}}}
  const backend=createBackendClient({wx:h.wx,config:{mode:'server',origin:'https://collect.linkx.ink'},now:()=>clock});let api=loadMarket(h.wx,backend)
  const prepared=await api.prepareUpload('original','main','thumb');lose='/api/v1/files/images';await assert.rejects(api.uploadPrepared(prepared),{code:'NETWORK_ERROR'})
  assert.equal(api.pendingUploads().length,1);api=loadMarket(h.wx,backend);const files=await api.uploadPrepared(api.pendingUploads()[0]);assert.equal(puts,2);assert.equal(api.pendingUploads().length,0)
  const start=new Date().toISOString().slice(0,10),end=new Date(Date.now()+86400000*14).toISOString().slice(0,10)
  const input=draft({pickupStartDate:start,pickupEndDate:end,imageFileIDs:[files.fileID],thumbFileIDs:[files.thumbFID]})
  lose='/api/v1/market/listings';await assert.rejects(api.call({data:{action:'create',payload:input}}),{code:'NETWORK_ERROR'})
  const created=(await api.call({data:{action:'create',payload:{...input,title:'New unsent'}}})).result;assert.equal(created.recovered,true)
  const listing=(await api.call({data:{action:'detail',id:created.id}})).result.item;assert.equal(listing.title,'Chair');assert.equal(listing.version,0);assert.deepEqual(plain(listing.thumbFileIDs),[files.thumbFID])
  assert.equal((await db.pool.query('SELECT count(*) FROM market_listings')).rows[0].count,'1')
  malformed=`/api/v1/market/listings/${created.id}`;await assert.rejects(api.call({data:{action:'update',id:created.id,expectedVersion:0,patch:{...input,title:'Saved once'}}}),{code:'INVALID_RESPONSE'})
  assert.ok(h.store[PENDING_KEY]?.length);const updated=(await api.call({data:{action:'update',id:created.id,expectedVersion:0,patch:{...input,title:'Different unsent'}}})).result
  assert.equal(updated.version,1);assert.equal(updated.recovered,true)
  const current=(await api.call({data:{action:'detail',id:created.id}})).result.item;assert.equal(current.title,'Saved once')
  await assert.rejects(api.call({data:{action:'update',id:created.id,expectedVersion:0,patch:input}}),{code:'LISTING_VERSION_CONFLICT'})
  const beforeURLs=requests.filter(row=>row.route==='/api/v1/files/urls').length;clock+=301000;await api.imageURLs([files.fileID]);assert.ok(requests.filter(row=>row.route==='/api/v1/files/urls').length>beforeURLs)
  const seller=await api.getSeller(login.json().data.user.id);assert.equal(seller.userId,login.json().data.user.id)
  h.store.isGuest=true
  const shared=(await api.call({data:{action:'sellerList',sellerId:'synthetic_market_client'}})).result
  assert.equal(shared.items.length,1);assert.equal(shared.items[0].seller,null);assert.equal(shared.items[0].sellerId,'')
  h.store.isGuest=false
  const previews=loadHelper('publicPreview.js',h.wx,backend);await previews.callPublicPreview({action:'marketDetail',id:created.id});assert.equal(requests.filter(row=>row.method==='GET').at(-1).authorization,undefined)
  lose=`/api/v1/market/listings/${created.id}`;await assert.rejects(api.call({data:{action:'delete',id:created.id,expectedVersion:1}}),{code:'NETWORK_ERROR'})
  await api.call({data:{action:'delete',id:created.id,expectedVersion:1}});assert.equal((await db.pool.query('SELECT status,version FROM market_listings')).rows[0].status,'deleted')
  for(const method of ['POST','PATCH','DELETE']){const matches=requests.filter(row=>row.route===`/api/v1/market/listings${method==='POST'?'':'/'+created.id}`&&row.method===method);assert.equal(matches[0].key,matches[1].key)}
})
