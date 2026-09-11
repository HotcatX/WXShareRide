const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createCommunityConfigHandler } = require('../cloudfunctions/marketApi/communityConfig')

const NOW = Date.parse('2026-09-10T16:00:00Z')
const EXPIRY = NOW + 7 * 86400000
const ENV = 'cloud1-community-test'
const GROUP_FILE = `cloud://${ENV}.bucket-123/community/group.png`
const NOTICE_FILE = `cloud://${ENV}.bucket-123/community/notice.jpg`
const imageURL = file => `https://bucket-123.tcb.qcloud.la/${file.split('/').slice(3).join('/')}?sign=temporary`
const group = (extra = {}) => ({ enabled: true, title: '加入拼车群', imageFileID: GROUP_FILE, expiresAt: new Date(EXPIRY), ...extra })
const announcement = (extra = {}) => ({ enabled: false, id: 'carpool-community-2026-09', title: '加入拼车群', body: '欢迎加入 Fort Lee 拼车群，交流出行与拼车信息。', showGroupImage: true, maxShows: 1, intervalHours: 24, ...extra })

function fixture(document, options = {}) {
  const calls = { reads: [], images: [], databaseOptions: [] }
  const context = { OPENID: options.openid || '', ENV }
  const db = {
    command: {},
    collection(collection) {
      return { doc(id) { return { field(projection) { return { async get() {
        calls.reads.push({ collection, id, projection })
        if (options.readError) throw new Error('sensitive-database-detail')
        return { data: document }
      } } } } } }
    }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, getWXContext: () => context,
    database(config) { calls.databaseOptions.push(config); return db },
    async getTempFileURL(args) {
      calls.images.push(args)
      if (options.imageError) throw new Error('sensitive-storage-detail')
      if (options.images) return options.images(args)
      return { fileList: args.fileList.map(fileID => ({ fileID, status: 0, tempFileURL: imageURL(fileID) })) }
    }
  }
  return { calls, db, cloud, context, handler: createCommunityConfigHandler({ db, cloud, now: options.now || (() => NOW), getEnvId: () => options.env === undefined ? ENV : options.env }) }
}

function entry(f) {
  const exports = {}
  const filename = path.resolve(__dirname, '../cloudfunctions/marketApi/index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, require(name) {
      if (name === 'wx-server-sdk') return f.cloud
      if (name === './communityConfig') return require('../cloudfunctions/marketApi/communityConfig')
      if (name === './publicPreview') return require('../cloudfunctions/marketApi/publicPreview')
      if (name === 'crypto') return require('node:crypto')
      throw new Error('Unexpected module: ' + name)
    }, console, Date, Intl, Set, Map, Buffer, process
  }, { filename })
  return exports.main
}

test('fixed main document returns only allowlisted fields and manual notice while automatic display is off', async () => {
  const f = fixture({ _id: 'main', adminSecret: 'private-root', group: group({ secret: 'private-group' }), announcement: announcement({ adminNote: 'private-announcement' }) })
  const result = await f.handler({ collection: 'userInfo', id: 'private-user', env: 'other-env' })
  assert.equal(result.ok, true)
  assert.equal(result.serverTime, NOW)
  assert.equal(result.group.enabled, true)
  assert.equal(result.announcement.available, true)
  assert.equal(result.announcement.enabled, false)
  assert.equal(result.announcement.body, announcement().body)
  assert.equal(result.announcement.imageUrl, result.group.imageUrl)
  assert.equal(result.announcement.endAt, EXPIRY)
  assert.deepEqual(Object.keys(result).sort(), ['announcement','group','ok','serverTime'])
  assert.deepEqual(Object.keys(result.group).sort(), ['enabled','expiresAt','imageUrl','title'])
  assert.deepEqual(Object.keys(result.announcement).sort(), ['available','body','enabled','endAt','id','imageUrl','intervalHours','maxShows','startAt','title'])
  assert.deepEqual(f.calls.reads.map(({collection,id})=>({collection,id})), [{ collection: 'community_config', id: 'main' }])
  assert.ok(Object.keys(f.calls.reads[0].projection).every(field => /^(group|announcement)\./.test(field)))
  assert.deepEqual(f.calls.images, [{ fileList: [GROUP_FILE] }])
  for (const secret of ['private-root','private-group','private-announcement','cloud://','imageFileID','adminSecret']) assert.ok(!JSON.stringify(result).includes(secret))
})

test('missing configuration and explicit switches default safely off', async () => {
  for (const document of [null, {}, { group: group({enabled:'true'}), announcement: {} }]) {
    const f=fixture(document),result=await f.handler()
    assert.equal(result.ok,true)
    assert.equal(result.group.enabled,false)
    assert.equal(result.announcement.available,false)
    assert.equal(result.announcement.enabled,false)
    assert.equal(f.calls.images.length,0)
  }
})

test('expired, missing and malformed group expiry suppress the group and any dependent manual announcement', async () => {
  for (const expiresAt of [NOW, NOW-1, undefined, '2026-02-30T12:00:00Z', '2026-09-17', '2026-09-17T12:00:00', {privateDate:EXPIRY}]) {
    const f=fixture({group:group({expiresAt}),announcement:announcement({enabled:true})})
    const result=await f.handler()
    assert.equal(result.group.enabled,false,String(expiresAt))
    assert.equal(result.announcement.available,false)
    assert.equal(result.announcement.enabled,false)
    assert.equal(result.group.imageUrl,'')
    assert.equal(result.announcement.imageUrl,'')
    assert.equal(f.calls.images.length,0)
  }
})

test('expiry accepts ISO timestamps, Date, cloud date and numeric milliseconds', async () => {
  for (const expiresAt of [new Date(EXPIRY), new Date(EXPIRY).toISOString(), {$date:EXPIRY}, {$date:new Date(EXPIRY).toISOString()}, {$date:{$numberLong:String(EXPIRY)}}, EXPIRY]) {
    const result=await fixture({group:group({expiresAt})}).handler()
    assert.equal(result.group.enabled,true)
    assert.equal(result.group.expiresAt,EXPIRY)
  }
})

test('only valid image file IDs from the current environment are sent to storage', async () => {
  for (const imageFileID of [GROUP_FILE.replace(ENV,'other-env'),GROUP_FILE.replace(ENV,ENV+'-other'),'https://example.com/code.png',GROUP_FILE.replace('group.png','../group.png'),GROUP_FILE.replace('group.png','%2e%2e/code.png'),GROUP_FILE.replace('.png','.svg'),GROUP_FILE+'?secret=yes',GROUP_FILE+'\n']) {
    const f=fixture({group:group({imageFileID}),announcement:announcement()})
    const result=await f.handler()
    assert.equal(result.group.enabled,false,imageFileID)
    assert.equal(result.announcement.available,false)
    assert.equal(f.calls.images.length,0)
  }
  const f=fixture({group:group()},{env:''})
  assert.equal((await f.handler()).group.enabled,false)
  assert.equal(f.calls.images.length,0)
})

test('unrelated or unsafe storage responses fail closed with friendly errors, not stale disabled config', async () => {
  const invalidResults = [
    {fileList:[]},
    {fileList:[{fileID:GROUP_FILE,status:1,tempFileURL:imageURL(GROUP_FILE)}]},
    {fileList:[{fileID:NOTICE_FILE,status:0,tempFileURL:imageURL(GROUP_FILE)}]},
    ...['http://bucket-123.tcb.qcloud.la/a.png','https://attacker.example/a.png','https://user:pass@bucket-123.tcb.qcloud.la/a.png','https://bucket-123.tcb.qcloud.la.evil.test/a.png'].map(tempFileURL=>({fileList:[{fileID:GROUP_FILE,status:0,tempFileURL}]})),
    {fileList:[{fileID:GROUP_FILE,tempFileURL:imageURL(GROUP_FILE)},{fileID:GROUP_FILE,tempFileURL:imageURL(GROUP_FILE)}]}
  ]
  for(const response of invalidResults){
    const result=await fixture({group:group()},{images:()=>response}).handler()
    assert.equal(result.ok,false)
    assert.equal(result.error,'community_config_unavailable')
    assert.equal(result.group,undefined)
  }
})

test('database and image-service errors remain distinguishable from deliberately disabled configuration', async () => {
  for(const options of [{readError:true},{imageError:true}]){
    const result=await fixture({group:group()},options).handler()
    assert.deepEqual(result,{ok:false,error:'community_config_unavailable',message:'暂时无法加载社群信息，请稍后重试'})
    assert.ok(!JSON.stringify(result).includes('sensitive-'))
  }
})

test('frequency bounds control only automatic display; zero interval remains valid', async () => {
  for(const [maxShows,intervalHours]of [[1,0],[100,8760],[2,0.5]]){
    const result=await fixture({announcement:announcement({enabled:true,showGroupImage:false,maxShows,intervalHours})}).handler()
    assert.equal(result.announcement.available,true)
    assert.equal(result.announcement.enabled,true)
    assert.equal(result.announcement.maxShows,maxShows)
    assert.equal(result.announcement.intervalHours,intervalHours)
  }
  for(const override of [{maxShows:0},{maxShows:101},{maxShows:1.5},{maxShows:'2'},{maxShows:null},{intervalHours:-1},{intervalHours:8761},{intervalHours:Infinity},{intervalHours:'24'}]){
    const result=await fixture({announcement:announcement({enabled:true,showGroupImage:false,...override})}).handler()
    assert.equal(result.announcement.available,true,'manual view should remain available')
    assert.equal(result.announcement.enabled,false)
    assert.equal(result.announcement.maxShows,0)
  }
  const result=await fixture({announcement:announcement({enabled:true,showGroupImage:false,maxShows:undefined,intervalHours:undefined})}).handler()
  assert.equal(result.announcement.maxShows,1)
  assert.equal(result.announcement.intervalHours,24)
})

test('valid identity, content and schedule are required for both automatic and manual announcements', async () => {
  for(const override of [{id:''},{id:'../private'},{body:''},{startAt:NOW+1},{endAt:NOW},{startAt:NOW+2,endAt:NOW+1},{startAt:'invalid'},{endAt:'2026-02-30T12:00:00Z'}]){
    const f=fixture({announcement:announcement({enabled:true,showGroupImage:false,...override})})
    const result=await f.handler()
    assert.equal(result.announcement.available,false,JSON.stringify(override))
    assert.equal(result.announcement.enabled,false)
    assert.equal(f.calls.images.length,0)
  }
  const result=await fixture({announcement:announcement({enabled:true,showGroupImage:false,startAt:NOW,endAt:NOW+1})}).handler()
  assert.equal(result.announcement.available,true)
})

test('custom announcement image works without a group and without a body', async () => {
  const f=fixture({announcement:announcement({showGroupImage:false,imageFileID:NOTICE_FILE,body:''})})
  const result=await f.handler()
  assert.equal(result.group.enabled,false)
  assert.equal(result.announcement.available,true)
  assert.equal(result.announcement.enabled,false)
  assert.equal(result.announcement.imageUrl,imageURL(NOTICE_FILE))
  assert.deepEqual(f.calls.images,[{fileList:[NOTICE_FILE]}])
})

test('group image selection has explicit precedence and always caps the notice expiry', async () => {
  const f=fixture({group:group(),announcement:announcement({imageFileID:NOTICE_FILE,endAt:EXPIRY+86400000,enabled:true})})
  const result=await f.handler()
  assert.deepEqual(f.calls.images,[{fileList:[GROUP_FILE]}])
  assert.equal(result.announcement.endAt,EXPIRY)
  assert.equal(result.announcement.imageUrl,result.group.imageUrl)
  const sooner=await fixture({group:group(),announcement:announcement({endAt:NOW+1000})}).handler()
  assert.equal(sooner.announcement.endAt,NOW+1000)
})

test('expiry is rechecked after asynchronous image resolution', async () => {
  let clock=NOW
  const f=fixture({group:group({expiresAt:NOW+1}),announcement:announcement({enabled:true})},{now:()=>clock,images:({fileList})=>{clock=NOW+1;return {fileList:fileList.map(fileID=>({fileID,status:0,tempFileURL:imageURL(fileID)}))}}})
  const result=await f.handler()
  assert.equal(result.serverTime,NOW+1)
  assert.equal(result.group.enabled,false)
  assert.equal(result.group.imageUrl,'')
  assert.equal(result.announcement.available,false)
  assert.equal(result.announcement.imageUrl,'')
})

test('configuration text is bounded and control characters do not enter the response', async () => {
  const result=await fixture({announcement:announcement({showGroupImage:false,title:'\u0000'+'题'.repeat(100),body:'行一\r\n\u202e'+'文'.repeat(2100)})}).handler()
  assert.equal(result.announcement.title.length,80)
  assert.equal(result.announcement.body.length,2000)
  assert.ok(!/[\u0000\u202e\r]/.test(result.announcement.title+result.announcement.body))
})

test('actual marketApi dispatch preserves the anonymous guard and keeps preview isolated', async () => {
  const f=fixture(null),main=entry(f)
  for(const action of ['communityConfig','publicConfig','list','create','delete']){
    const result=await main({action,OPENID:'forged-user',collection:'userInfo',id:'private-user'})
    assert.equal(result.error,'not_logged_in')
  }
  assert.equal(f.calls.reads.length,0)
  const preview=await main({action:'publicPreview',previewAction:'communityConfig'})
  assert.equal(preview.error,'invalid_preview_request')
  assert.equal(f.calls.reads.length,0)
  f.context.OPENID='real-context-user'
  const result=await main({action:'communityConfig',collection:'userInfo',id:'private-user'})
  assert.equal(result.ok,true)
  assert.equal(f.calls.reads[0].collection,'community_config')
  assert.equal(f.calls.reads[0].id,'main')
  assert.equal(f.calls.databaseOptions.at(-1).throwOnNotFound,false)
})
