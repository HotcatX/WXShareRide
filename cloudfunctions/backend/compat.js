// Narrow transitional operations for the three former client-database writers.
// CloudBase remains authoritative. There is no collection/URL/method proxy.
// Remove only after the single-PG-writer handoff, receipt import/replay and old
// client compatibility are verified. Never select it after an HTTP failure.
const crypto = require('crypto')
const { getIdentity } = require('./context')
const { record, reject, read, intent, mutate, bulk } = require('./receipts')
const READS = new Set(['identity', 'templates.list', 'templates.get', 'notifications.list', 'notifications.unread'])
const WRITES = new Set(['templates.create', 'templates.update', 'templates.delete', 'notifications.read', 'notifications.readAll', 'notifications.clear', 'profile.spots.add', 'profile.spots.remove'])
function userId(identity) {
  const bytes = crypto.createHash('sha256').update(JSON.stringify(['linkx-user-v1', identity.appId, identity.openid])).digest().subarray(0,16)
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
}
function fields(body, required, optional = []) {
  if (!record(body) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(body,key))) reject('INVALID_INPUT')
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) reject('INVALID_INPUT'); return value }
function text(value, max, empty = false) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > max || !empty && !value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) reject('INVALID_INPUT')
  return value
}
function template(value) {
  fields(value, ['templateName','departureAddress','destinationAddress','weekdayIndex','weekdayText','departureTime','passengerCount','referencePrice','comment'], ['carNumber','carBrand','carModel','zelle'])
  text(value.templateName,120); text(value.departureAddress,300); text(value.destinationAddress,300)
  if (value.departureAddress === value.destinationAddress || !Number.isInteger(value.weekdayIndex) || value.weekdayIndex < 0 || value.weekdayIndex > 6 ||
    value.weekdayText !== ['周一','周二','周三','周四','周五','周六','周日'][value.weekdayIndex] || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.departureTime) ||
    !Number.isInteger(value.passengerCount) || value.passengerCount < 1 || value.passengerCount > 8) reject('INVALID_INPUT')
  text(value.referencePrice,1000,true); text(value.comment,1000,true)
  for (const key of ['carNumber','carBrand','carModel']) if (Object.hasOwn(value,key)) text(value[key],100,true)
  if (Object.hasOwn(value,'zelle') && !['yes','no'].includes(value.zelle)) reject('INVALID_INPUT')
  return value
}
async function owned(db, collection, key, identity) {
  const row = await read(db,collection,key)
  if (!row || row._openid !== identity.openid) reject('NOT_FOUND',404)
  return row
}
async function targetIds(db, openid, unread) {
  const all = []; let last
  while (true) {
    const where = { _openid: openid, ...(unread ? { read: false } : {}), ...(last ? { _id: db.command.gt(last) } : {}) }
    const result = await db.collection('Notifications').where(where).orderBy('_id','asc').limit(100).get()
    if (!Array.isArray(result.data)) throw Error('INVALID_DB_RESPONSE')
    const ids = result.data.map(row => id(row._id))
    if (ids.some((value,index) => value <= (index ? ids[index-1] : last || ''))) throw Error('INVALID_DB_RESPONSE')
    all.push(...ids)
    if (Buffer.byteLength(JSON.stringify(all)) > 512000) reject('TOO_MANY_NOTIFICATIONS',413)
    if (ids.length < 100) return all
    last = ids.at(-1)
  }
}
function createCompatHandler({ getDb }) {
  return async (event, context) => {
    try {
      const identity = getIdentity(context)
      if (!identity) reject('UNAUTHORIZED',401)
      const input = Object.fromEntries(Object.entries(record(event) ? event : {}).filter(([key]) => !['userInfo','tcbContext'].includes(key)))
      fields(input,['action','body','expectedOpenid'],['key'])
      if (input.expectedOpenid !== identity.openid) reject('IDENTITY_CHANGED',403)
      const { action, body } = input
      if (!READS.has(action) && !WRITES.has(action)) reject('INVALID_ACTION')
      const actor = { appId: identity.appId, openid: identity.openid, id: userId(identity) }
      const receipt = WRITES.has(action) ? intent(identity,action,input.key,body) : null
      if (!receipt && Object.hasOwn(input,'key')) reject('INVALID_INPUT')
      const db = action === 'identity' ? null : getDb()
      let data
      if (action === 'identity') { fields(body,[]); data = actor }
      else if (action === 'templates.list') {
        fields(body,['page']); if (!Number.isInteger(body.page) || body.page < 1 || body.page > 1000) reject('INVALID_INPUT')
        const result = await db.collection('CarpoolTemplate').where({_openid:identity.openid}).orderBy('createdAt','desc').orderBy('_id','desc').skip((body.page-1)*100).limit(100).get()
        data = {items:result.data,page:body.page}
      } else if (action === 'templates.get') { fields(body,['id']); data = await owned(db,'CarpoolTemplate',id(body.id),identity) }
      else if (action === 'templates.create' || action === 'templates.update') {
        fields(body,action === 'templates.create' ? ['form'] : ['id','form']); template(body.form)
        if (action === 'templates.update') id(body.id)
        const newId = action === 'templates.create' ? crypto.randomUUID() : body.id
        data = await mutate(db,receipt,async tx => {
          const old = action === 'templates.update' ? await owned(tx,'CarpoolTemplate',newId,identity) : null
          const stamp = new Date(), next = {...(old || {}),...body.form,_openid:identity.openid,createdAt:old?.createdAt || stamp,updatedAt:stamp}
          delete next._id
          await tx.collection('CarpoolTemplate').doc(newId).set({data:next})
          return {_id:newId,...next}
        })
      } else if (action === 'templates.delete') {
        fields(body,['id']); id(body.id)
        data = await mutate(db,receipt,async tx => { await owned(tx,'CarpoolTemplate',body.id,identity); await tx.collection('CarpoolTemplate').doc(body.id).remove(); return {id:body.id,deleted:true} })
      } else if (action === 'notifications.list' || action === 'notifications.unread') {
        fields(body,[])
        const unread = await db.collection('Notifications').where({_openid:identity.openid,read:false}).count()
        data = {unreadCount:unread.total}
        if (action === 'notifications.list') { const rows = await db.collection('Notifications').where({_openid:identity.openid}).orderBy('createdAt','desc').orderBy('_id','desc').limit(100).get(); data.items=rows.data; data.nextCursor=null }
      } else if (action === 'notifications.read') {
        fields(body,['id']); id(body.id)
        data = await mutate(db,receipt,async tx => { await owned(tx,'Notifications',body.id,identity); await tx.collection('Notifications').doc(body.id).update({data:{read:true}}); return {id:body.id,read:true} })
      } else if (action === 'notifications.readAll' || action === 'notifications.clear') {
        fields(body,[]); const clear = action === 'notifications.clear'
        data = await bulk(db,receipt,()=>targetIds(db,identity.openid,!clear),async (tx,key) => {
          const row = await read(tx,'Notifications',key)
          if (!row || row._openid !== identity.openid || !clear && row.read) return false
          if (clear) await tx.collection('Notifications').doc(key).remove()
          else await tx.collection('Notifications').doc(key).update({data:{read:true}})
          return true
        },clear ? 'deleted':'changed')
      } else {
        fields(body,['field','value']); if (!['pickupSpot','dropoffSpot'].includes(body.field)) reject('INVALID_INPUT'); text(body.value,300)
        // Locate only; the user document and owner are rechecked inside the write transaction.
        data = await mutate(db,receipt,async tx => {
          const found = await db.collection('userInfo').where({_openid:identity.openid}).limit(2).get()
          if (found.data.length !== 1) reject('PROFILE_NOT_FOUND',409)
          const userKey = id(found.data[0]._id)
          const user = await owned(tx,'userInfo',userKey,identity), old = user[body.field] || []
          if (!Array.isArray(old) || old.some(value=>typeof value !== 'string')) reject('INVALID_PROFILE',409)
          const values = action === 'profile.spots.add' ? [...new Set([...old,body.value])] : old.filter(value=>value!==body.value)
          if (values.length>20) reject('TOO_MANY_ADDRESSES')
          await tx.collection('userInfo').doc(userKey).update({data:{[body.field]:values,updateTime:new Date()}})
          return {field:body.field,values}
        })
      }
      return {ok:true,data,actor}
    } catch (error) {
      const known = /^[A-Z0-9_]{1,80}$/.test(error.code || '') && Number.isInteger(error.status)
      return {ok:false,error:{code:known?error.code:'OPERATION_UNAVAILABLE',status:known?error.status:503,message:'操作暂未完成，请重试'}}
    }
  }
}
module.exports = { createCompatHandler, READS, WRITES, userId }
