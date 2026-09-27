// Pure shared locator algorithm; hash is supplied by the host runtime.
function templateId(appId, sourceId, sha256) {
  if (/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(sourceId)) return sourceId.toLowerCase()
  const hash = sha256(JSON.stringify(['linkx-template-v1', appId, sourceId])).slice(0, 32)
  const hex = hash.slice(0, 12) + '8' + hash.slice(13, 16) + ((parseInt(hash[16], 16) & 3) | 8).toString(16) + hash.slice(17)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
module.exports = { templateId }
