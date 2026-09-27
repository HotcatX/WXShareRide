// Temporary CloudBase handoff ledger. One original intent and its exact reply;
// never a second business database or a payload-hash substitute for a key.
const crypto = require('crypto')
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const ordered = value => Array.isArray(value) ? value.map(ordered) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
const hash = value => crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
function reject(code, status = 400) { throw Object.assign(new Error(code), { code, status }) }
async function read(db, collection, id) {
  try { const result = await db.collection(collection).doc(id).get(); return result.data || null }
  catch (error) {
    if (error.code === 'DOCUMENT_NOT_FOUND' || /document[^\n]*(?:not exist|not found)/i.test(error.errMsg || error.message || '')) return null
    throw error
  }
}
async function transaction(db, work) {
  const result = await db.runTransaction(async tx => ({ receiptValue: await work(tx) }))
  const value = result && Object.hasOwn(result, 'receiptValue') ? result : result?.result
  if (!value || !Object.hasOwn(value, 'receiptValue')) throw Error('INVALID_TRANSACTION_RESPONSE')
  return value.receiptValue
}
function intent(identity, action, key, payload) {
  if (!record(payload)) reject('INVALID_INPUT')
  if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) reject('IDEMPOTENCY_KEY_REQUIRED')
  const raw = JSON.stringify(ordered(payload))
  if (Buffer.byteLength(raw) > 65536) reject('INVALID_INPUT')
  return { id: hash([identity.appId, identity.openid, action, key]), appId: identity.appId, openid: identity.openid,
    action, key, payload: JSON.parse(raw), payloadHash: hash(payload) }
}
function verify(row, input) {
  if (row.appId !== input.appId || row.openid !== input.openid || row.action !== input.action || row.key !== input.key || row.payloadHash !== input.payloadHash) reject('IDEMPOTENCY_CONFLICT', 409)
}
async function mutate(db, input, work) {
  return transaction(db, async tx => {
    const old = await read(tx, 'OperationReceipts', input.id)
    if (old) { verify(old, input); if (old.state !== 'completed') reject('OPERATION_PENDING', 503); return old.response }
    const response = await work(tx)
    await tx.collection('OperationReceipts').doc(input.id).set({ data: { ...input, state: 'completed', response, createdAt: new Date(), completedAt: new Date() } })
    return response
  })
}
// CloudBase limits a transaction to 100 document operations. Freeze the exact
// recipient-owned IDs once, then commit each 40-document batch and progress
// together. Retrying cannot consume notifications received after preparation.
async function bulk(db, input, select, change, resultField) {
  let row = await read(db, 'OperationReceipts', input.id)
  if (!row) {
    const targets = await select()
    if (Buffer.byteLength(JSON.stringify(targets)) > 512000) reject('TOO_MANY_NOTIFICATIONS', 413)
    row = await transaction(db, async tx => {
      const old = await read(tx, 'OperationReceipts', input.id)
      if (old) { verify(old, input); return old }
      const next = { ...input, state: 'prepared', targets, offset: 0, affected: 0, createdAt: new Date() }
      await tx.collection('OperationReceipts').doc(input.id).set({ data: next }); return next
    })
  }
  verify(row, input)
  const started = Date.now()
  while (row.state !== 'completed') {
    if (Date.now() - started > 8000) reject('OPERATION_PENDING', 503)
    row = await transaction(db, async tx => {
      const fresh = await read(tx, 'OperationReceipts', input.id); verify(fresh, input)
      if (fresh.state === 'completed') return fresh
      const batch = fresh.targets.slice(fresh.offset, fresh.offset + 40)
      let affected = fresh.affected
      for (const id of batch) if (await change(tx, id)) affected++
      const offset = fresh.offset + batch.length, completed = offset === fresh.targets.length
      const patch = { offset, affected, ...(completed ? { state: 'completed', response: { [resultField]: affected }, completedAt: new Date() } : {}) }
      await tx.collection('OperationReceipts').doc(input.id).update({ data: patch })
      return { ...fresh, ...patch }
    })
  }
  return row.response
}
module.exports = { record, ordered, hash, reject, read, transaction, intent, mutate, bulk }
