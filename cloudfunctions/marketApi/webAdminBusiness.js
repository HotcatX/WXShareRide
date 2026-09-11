const crypto = require('crypto')
const { reject, record, hash, id, read, transaction, writeAudit } = require('./webAdminSecurity')
const { clean } = require('./webAdminContent')
const GOODS = 'market_goods'
const TEMPLATES = 'MarketAdminTemplates'
const TEXT_FIELDS = ['title', 'category', 'condition', 'region', 'regionState', 'regionCounty', 'regionArea', 'Apartment', 'regionDisplay', 'buildingName', 'sellerName', 'sellerWechat', 'sellerPhone', 'sellerNote', 'pickupStartDate', 'pickupEndDate', 'availableStartDate', 'leaseEndDate', 'deposit', 'roomType', 'housingType', 'genderPreference', 'roommateCount']
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
function payload(input = {}, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('invalid_item')
  const out = {}
  for (const key of TEXT_FIELDS) if (input[key] !== undefined) out[key] = clean(String(input[key]), key === 'sellerNote' ? 2000 : 240)
  if (out.regionState) out.regionState = ({ '新泽西': 'NJ', 'NEW JERSEY': 'NJ', '纽约': 'NY', 'NEW YORK': 'NY' })[out.regionState.toUpperCase()] || out.regionState.toUpperCase()
  if (input.desc !== undefined) out.desc = clean(input.desc, 10000)
  if (input.listingType !== undefined || !partial) {
    if (input.listingType !== undefined && !['goods', 'sublet'].includes(input.listingType)) reject('invalid_listing_type')
    out.listingType = input.listingType || 'goods'
  }
  if (input.price !== undefined || !partial) {
    const price = Number(input.price === undefined ? 0 : input.price)
    if (!Number.isFinite(price) || price < 0 || price > 100000000) reject('invalid_price')
    out.price = price
  }
  for (const key of ['furnished', 'utilitiesIncluded']) if (input[key] !== undefined) out[key] = input[key] === true
  if (input.location !== undefined) {
    const source = record(input.location), location = {}
    for (const key of ['latitude', 'longitude']) if (source[key] !== undefined) {
      const number = Number(source[key]), max = key === 'latitude' ? 90 : 180
      if (!Number.isFinite(number) || Math.abs(number) > max) reject('invalid_location')
      location[key] = number
    }
    for (const key of ['name', 'address', 'displayName', 'cityKey', 'cityLabel', 'regionState', 'regionArea', 'regionKey', 'areaLabel', 'buildingName']) if (source[key] !== undefined) location[key] = clean(source[key], 240)
    out.location = location
  }
  for (const [single, multiple] of [['imageFileID', 'imageFileIDs'], ['thumbFileID', 'thumbFileIDs']]) {
    if (input[single] === undefined && input[multiple] === undefined && partial) continue
    if (input[multiple] !== undefined && !Array.isArray(input[multiple])) reject('invalid_images')
    if (Array.isArray(input[multiple]) && input[multiple].length > 6) reject('too_many_images')
    const values = [...new Set([input[single], ...(input[multiple] || [])].filter(value => value !== undefined && value !== ''))]
    if (values.length > 6) reject('too_many_images')
    if (values.some(value => typeof value !== 'string')) reject('invalid_images')
    out[single] = values[0] || ''
    out[multiple] = values
  }
  return out
}
function canManage(item, account) {
  return item && item.managedByAdmin === true && (item.ownerKey === account.ownerKey || (!item.ownerKey && typeof item._openid === 'string' && !!item._openid))
}
function itemView(row) {
  const data = payload(row)
  return { ...data, id: row._id, _id: row._id, status: clean(row.status, 20), externalId: clean(row.adminExternalId, 128), version: Number.isSafeInteger(row.webAdminVersion) ? row.webAdminVersion : 0 }
}
function normalizedTree(rows) {
  return rows.map(row => {
    const key = clean(row.key || row._id || row.state, 80)
    const groups = Array.isArray(row.groups) ? row.groups : Object.keys(row).filter(key => !key.startsWith('_') && Array.isArray(row[key])).map(key => ({ key, areas: row[key] }))
    return { key, label: key === 'NY' ? '纽约' : key === 'NJ' ? '新泽西' : clean(row.label, 80) || key, groups: groups.slice(0, 100).map(group => ({ key: clean(group.key || group.label, 80), label: clean(group.label || group.key, 80), areas: [...new Set((Array.isArray(group.areas) ? group.areas : []).filter(x => typeof x === 'string').map(x => clean(x, 100)))].slice(0, 200) })).filter(group => group.key && group.areas.length) }
  }).filter(state => state.key && state.groups.length)
}

function createBusiness({ db, now = Date.now, content, buildCreateItemForSave, normalizePayloadForSave, attachMarketFiles, collectMarketFiles }) {
  async function validateFiles(data, account) {
    for (const fileID of data.imageFileIDs || []) await content.owned(fileID, account, 'market')
    for (const fileID of data.thumbFileIDs || []) await content.owned(fileID, account, 'market_thumb')
  }
  async function attach(data, itemId, account) {
    await attachMarketFiles(collectMarketFiles(data), itemId, '', { ownerKey: account.ownerKey, accountId: account.accountId, strict: true })
  }
  async function saveRow(raw, account, batchId, index) {
    const source = payload(raw)
    source.category = source.category || source.roomType || (source.listingType === 'sublet' ? 'Studio' : '其他')
    source.condition = source.condition || (source.listingType === 'sublet' ? '转租' : '99新')
    const externalId = id(raw.externalId || raw.adminExternalId || raw.importId || `row_${index + 1}`)
    if (!externalId) reject('invalid_external_id')
    const requestKey = id(raw.clientRequestId) || ((raw.externalId || raw.adminExternalId || raw.importId) ? `external_${externalId}` : `${batchId}_${externalId}`)
    const requestHash = hash(JSON.stringify(stable(source)))
    const itemId = 'web_' + hash(`${account.ownerKey}:${requestKey}`).slice(0, 48)
    // Check the permanent ledger before rebuilding date defaults: a retry after
    // midnight must return the original item, never extend its expiry.
    const existing = await read(db, GOODS, itemId)
    if (existing) {
      if (existing.ownerKey !== account.ownerKey || existing.webAdminRequestHash !== requestHash) reject('idempotency_conflict', 409)
      await validateFiles(existing, account)
      await attach(existing, itemId, account)
      return { ok: true, id: itemId, itemId, title: existing.title, listingType: existing.listingType, externalId, status: existing.status, deduped: true }
    }
    await validateFiles(source, account)
    const built = buildCreateItemForSave(source, account.ownerKey)
    if (!built || !built.ok) reject(built && built.error || 'invalid_item')
    const data = { ...built.data, ownerKey: account.ownerKey, managedByAdmin: true, managedByAccountId: account.accountId, managedByOwnerKey: account.ownerKey, managedSource: 'web_admin', adminBatchId: batchId, adminExternalId: externalId, webAdminRequestHash: requestHash, webAdminVersion: 0 }
    delete data._openid
    delete data.managedByOpenid
    const saved = await transaction(db, async tx => {
      const fresh = await read(tx, GOODS, itemId)
      if (fresh) {
        if (fresh.ownerKey !== account.ownerKey || fresh.webAdminRequestHash !== requestHash) reject('idempotency_conflict', 409)
        return { data: fresh, deduped: true }
      }
      await tx.collection(GOODS).doc(itemId).set({ data })
      await writeAudit(tx, account, 'createItem', { itemId, batchId, externalId, requestHash }, now())
      return { data, deduped: false }
    })
    await attach(saved.data, itemId, account)
    return { ok: true, id: itemId, itemId, title: saved.data.title, listingType: saved.data.listingType, externalId, status: saved.data.status, deduped: saved.deduped }
  }
  async function bulkCreate(input, account) {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) reject('invalid_items')
    const batchId = id(input.batchId)
    if (!batchId) reject('invalid_batch_id')
    const batchKey = 'web_' + hash(`${account.ownerKey}:${batchId}`).slice(0, 48)
    // Keep row identities in this hash, while discarding unknown input fields.
    const requestHash = hash(JSON.stringify(stable(input.items.map((raw, index) => {
      try { return { item: payload(raw), externalId: id(raw.externalId || raw.adminExternalId || raw.importId || `row_${index + 1}`), clientRequestId: id(raw.clientRequestId) } }
      catch (_) { return { invalid: hash(JSON.stringify(stable(raw))) } }
    }))))
    const previousCompletion = await transaction(db, async tx => {
      const previous = await read(tx, 'MarketImportBatches', batchKey)
      if (previous) {
        if (previous.ownerKey !== account.ownerKey || previous.requestHash !== requestHash) reject('idempotency_conflict', 409)
        return previous.status === 'done' ? previous : null
      }
      await tx.collection('MarketImportBatches').doc(batchKey).set({ data: { batchId, ownerKey: account.ownerKey, accountId: account.accountId, type: 'market_admin_bulk', source: 'web_admin', requestHash, total: input.items.length, status: 'running', createdAtMs: now() } })
      await writeAudit(tx, account, 'bulkCreate', { batchId, total: input.items.length, requestHash }, now())
      return null
    })
    const completedResponse = batch => ({ ok: true, batchId, total: batch.total, success: batch.total, failed: 0, results: (batch.results || []).map(row => ({ ...row, ok: true, itemId: row.id, deduped: true })), failures: [] })
    if (previousCompletion) return completedResponse(previousCompletion)
    const results = [], failures = []
    for (let index = 0; index < input.items.length; index++) {
      try { results.push({ index, ...await saveRow(input.items[index], account, batchId, index) }) }
      catch (error) { failures.push({ index, error: error && typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'item_save_failed' }) }
    }
    const concurrentlyCompleted = await transaction(db, async tx => {
      const previous = await read(tx, 'MarketImportBatches', batchKey)
      // An interrupted concurrent invocation cannot downgrade a completed batch.
      if (previous.status === 'done') return previous
      await tx.collection('MarketImportBatches').doc(batchKey).update({ data: { success: results.length, failed: failures.length, status: failures.length ? (results.length ? 'partial' : 'failed') : 'done', results: results.map(row => ({ index: row.index, id: row.id, externalId: row.externalId })), failures, updatedAtMs: now() } })
      return null
    })
    if (concurrentlyCompleted) return completedResponse(concurrentlyCompleted)
    return { ok: true, batchId, total: input.items.length, success: results.length, failed: failures.length, results, failures }
  }
  async function getItem(input, account) {
    if (!id(input.id)) reject('invalid_item_id')
    const row = await read(db, GOODS, input.id)
    if (!canManage(row, account)) reject('item_not_found', 404)
    return { ok: true, item: itemView({ ...row, _id: input.id }) }
  }
  async function updateItem(input, account) {
    if (!id(input.id) || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) reject('invalid_item')
    const patch = payload(input.patch, true)
    if (!Object.keys(patch).length) reject('invalid_item')
    const existing = await read(db, GOODS, input.id)
    if (!canManage(existing, account)) reject('item_not_found', 404)
    await validateFiles(patch, account)
    const requestHash = hash(JSON.stringify(stable(patch)))
    const result = await transaction(db, async tx => {
      const fresh = await read(tx, GOODS, input.id)
      if (!canManage(fresh, account)) reject('item_not_found', 404)
      const version = Number.isSafeInteger(fresh.webAdminVersion) ? fresh.webAdminVersion : 0
      if (version !== input.expectedVersion) {
        if (version === input.expectedVersion + 1 && fresh.webAdminLastUpdateHash === requestHash && fresh.webAdminUpdatedBy === account.accountId) return { ...fresh, _id: input.id }
        reject('version_conflict', 409)
      }
      const normalized = normalizePayloadForSave(patch, fresh)
      if (!normalized || !normalized.ok) reject(normalized && normalized.error || 'invalid_item')
      const data = { ...normalized.data, updateTime: db.serverDate(), webAdminUpdatedBy: account.accountId, webAdminUpdatedAtMs: now(), webAdminVersion: version + 1, webAdminLastUpdateHash: requestHash }
      // The normalizer emits business fields only; identity/status/create time
      // and the permanent create idempotency key are never taken from the patch.
      delete data.status
      await tx.collection(GOODS).doc(input.id).update({ data })
      await writeAudit(tx, account, 'updateItem', { itemId: input.id, fields: Object.keys(patch), requestHash, version: version + 1 }, now())
      return { ...fresh, ...data, _id: input.id }
    })
    await attach(result, input.id, account)
    return { ok: true, id: input.id, item: itemView(result) }
  }
  function templateView(row) {
    const data = payload(record(row.data))
    // Templates never carry cloud image pointers or arbitrary stored metadata.
    delete data.imageFileID; delete data.imageFileIDs; delete data.thumbFileID; delete data.thumbFileIDs
    return { id: row._id, _id: row._id, name: clean(row.name, 60), data }
  }
  async function listTemplates() {
    const response = await db.collection(TEMPLATES).where({ status: 'active' }).limit(100).get()
    return { ok: true, templates: (response.data || []).map(templateView) }
  }
  async function saveTemplate(input, account) {
    const source = record(input.template)
    const name = clean(source.name, 60)
    const data = templateView({ data: source.data || source }).data
    if (!name || !data.sellerName || !(data.sellerWechat || data.sellerPhone)) reject('missing_template_contact')
    if (!data.regionState || !data.regionCounty || !data.regionArea) reject('missing_template_region')
    const templateId = source.id || source._id || source.templateId || `web_tpl_${hash(`${account.ownerKey}:${name}`).slice(0, 40)}`
    if (!id(templateId)) reject('invalid_template_id')
    await transaction(db, async tx => {
      const old = await read(tx, TEMPLATES, templateId)
      if (!old && !templateId.startsWith('web_tpl_')) reject('template_not_found', 404)
      const row = { name, data, status: 'active', updatedBy: account.accountId, updatedAtMs: now() }
      if (old) await tx.collection(TEMPLATES).doc(templateId).update({ data: row })
      else await tx.collection(TEMPLATES).doc(templateId).set({ data: { ...row, ownerKey: account.ownerKey, createdBy: account.accountId, createdAtMs: now() } })
      await writeAudit(tx, account, 'saveTemplate', { templateId }, now())
    })
    return { ok: true, id: templateId, template: { id: templateId, _id: templateId, name, data } }
  }
  async function deleteTemplate(input, account) {
    if (!id(input.id)) reject('invalid_template_id')
    await transaction(db, async tx => {
      const old = await read(tx, TEMPLATES, input.id)
      if (!old) reject('template_not_found', 404)
      await tx.collection(TEMPLATES).doc(input.id).update({ data: { status: 'deleted', updatedBy: account.accountId, updatedAtMs: now() } })
      await writeAudit(tx, account, 'deleteTemplate', { templateId: input.id }, now())
    })
    return { ok: true, id: input.id }
  }
  async function bootstrap() {
    const [regions, community, templates] = await Promise.all([db.collection('CITY_TREE').limit(100).get(), content.getCommunity(), listTemplates()])
    return { ok: true, regionTree: normalizedTree(regions.data || []), community: { ...community.config, version: community.version }, templates: templates.templates }
  }
  return { bootstrap, bulkCreate, getItem, updateItem, listTemplates, saveTemplate, deleteTemplate }
}

module.exports = { createBusiness, payload, canManage, normalizedTree, stable }
