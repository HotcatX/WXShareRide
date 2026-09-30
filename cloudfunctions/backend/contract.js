// Finite compatibility operations forwarded to the same PostgreSQL backend.
// These are wire contracts for released clients, not CloudBase database access.
const READS = new Set(['identity', 'templates.list', 'templates.get', 'notifications.list', 'notifications.unread'])
const WRITES = new Set(['templates.create', 'templates.update', 'templates.delete', 'notifications.read', 'notifications.readAll', 'notifications.clear', 'profile.spots.add', 'profile.spots.remove'])
const record = value => value && typeof value === 'object' && !Array.isArray(value)

module.exports = { READS, WRITES, record }
