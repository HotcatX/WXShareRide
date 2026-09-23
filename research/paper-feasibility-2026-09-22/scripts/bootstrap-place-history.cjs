// Read-only, one-time legacy snapshot export; never uploads or mutates cloud data.
// Reuse these exact private output files for delivery retries. Regenerating later
// is a different observation and can conflict with the receiver's version-0 fact.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { snapshot } = require('../../../cloudfunctions/tripManage/businessLedger')
const { getRideDateTime, shiftRideDate } = require('../../../utils/rideTime')
const OPENID = /^[A-Za-z0-9_-]{16,128}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/
const validDate = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const PROJECTION = {
  _id: 1, _openid: 1, 'passengers._openid': 1, passengerID: 1, driverOpenid: 1,
  status: 1, 'departures.address': 1, 'departures.date': 1, 'departures.time': 1,
  'destinations.address': 1, 'destinations.date': 1, 'destinations.time': 1,
  referencePrice: 1, cityKey: 1, firstDepartureDate: 1, departureAtMs: 1,
  latestDepartureAtMs: 1, availSeatNum: 1, passengerCount: 1, businessVersion: 1,
  businessSynthetic: 1, isDeleted: 1, deleted: 1, isCancelled: 1, isCanceled: 1,
  cancelled: 1, canceled: 1, deletedAt: 1, cancelledAt: 1, canceledAt: 1
}
const flags = ['isDeleted', 'deleted', 'isCancelled', 'isCanceled', 'cancelled', 'canceled', 'deletedAt', 'cancelledAt', 'canceledAt']
function normalizeRow(row, type) {
  const cleanPoint = p => ({ address: typeof p?.address === 'string' ? p.address : '',
    date: validDate(p?.date) ? p.date : '', time: typeof p?.time === 'string' ? p.time : '' })
  const result = {
    _id: row._id, _openid: row._openid, status: row.status || 'open', cityKey: row.cityKey || 'ny_nj',
    departures: (Array.isArray(row.departures) ? row.departures : []).map(cleanPoint),
    destinations: (Array.isArray(row.destinations) ? row.destinations : []).map(cleanPoint),
    referencePrice: row.referencePrice, firstDepartureDate: row.firstDepartureDate,
    departureAtMs: row.departureAtMs, latestDepartureAtMs: row.latestDepartureAtMs,
    availSeatNum: row.availSeatNum, passengerCount: row.passengerCount,
    driverOpenid: OPENID.test(row.driverOpenid || '') ? row.driverOpenid : '',
    passengers: (Array.isArray(row.passengers) ? row.passengers : []).map(p => typeof p === 'string' ? p : p?._openid)
      .filter(value => OPENID.test(value || '')).map(_openid => ({ _openid })),
    passengerID: (Array.isArray(row.passengerID) ? row.passengerID : []).filter(value => OPENID.test(value || ''))
  }
  if (!validDate(result.firstDepartureDate)) result.firstDepartureDate = result.departures[0]?.date || ''
  return snapshot(type, result, 0)
}
function makeBaseline(row, type, { today, observedAt }) {
  if (!row || !ID.test(row._id || '') || !OPENID.test(row._openid || '')) return { skip: 'invalidIdentity' }
  if (Number(row.businessVersion) > 0) return { skip: 'newLedgerAlreadyPresent' }
  if (row.businessSynthetic === true) return { skip: 'synthetic' }
  if (flags.some(key => !!row[key]) || !['open', 'full', 'past', 'close'].includes(row.status || 'open')) return { skip: 'cancelledOrUnsupported' }
  const after = normalizeRow(row, type)
  if (!validDate(after.serviceDate)) return { skip: 'unknownServiceDate' }
  if (after.serviceDate < shiftRideDate(today, -90) || after.serviceDate > shiftRideDate(today, 90)) return { skip: 'outsideWindow' }
  if (!after.departures.length || !after.destinations.length || !after.departures[0].address || !after.destinations[0].address) return { skip: 'missingEndpoints' }
  const eventId = createHash('sha256').update(JSON.stringify(['legacy-place-v1', type, row._id, after])).digest('hex')
  return { event: { schemaVersion: 1, eventId, tripId: row._id, tripType: type,
    action: 'legacy_snapshot', actorOpenid: row._openid, eventAtMs: observedAt,
    version: 0, before: null, after, affectedOpenids: after.participantEdges.map(edge => edge.openid),
    synthetic: false, source: 'legacy_snapshot' } }
}
function packBatches(events, maxBytes = 56 * 1024) {
  const batches = []
  let current = []
  for (const event of events) {
    if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, events: [event] })) > maxBytes) throw new Error('oversized_legacy_event')
    if (current.length >= 10 || Buffer.byteLength(JSON.stringify({ schemaVersion: 1, events: current.concat(event) })) > maxBytes) {
      batches.push({ schemaVersion: 1, events: current }); current = []
    }
    current.push(event)
  }
  if (current.length) batches.push({ schemaVersion: 1, events: current })
  return batches
}
async function main(argv = process.argv.slice(2)) {
  const arg = key => { const at = argv.indexOf(key); return at >= 0 ? argv[at + 1] : '' }
  const appid = arg('--appid'), env = arg('--env'), output = path.resolve(arg('--output') || '.')
  if (!appid || !env || !arg('--output') || !/^wx[a-z0-9]+$/.test(appid) || !/^[a-z0-9_-]+$/i.test(env)) throw new Error('explicit_appid_env_output_required')
  // Existing output is intentionally never overwritten: it may already have
  // been partly delivered, and exact bytes are necessary for idempotent retry.
  if (fs.existsSync(output)) throw new Error('output_must_not_exist')
  fs.mkdirSync(output, { mode: 0o700 })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkx-place-baseline-'))
  fs.chmodSync(temp, 0o700)
  const observedAt = Date.now(), today = getRideDateTime().date
  const { validateBusinessEvents } = await import(pathToFileURL(path.resolve(__dirname, '../../../services/research-collector/src/places.mjs')).href)
  const report = { observedAt: new Date(observedAt).toISOString(), today, lowerServiceDate: shiftRideDate(today, -90), upperServiceDate: shiftRideDate(today, 90),
    source: 'legacy_snapshot', calls: 0, collections: [], skipped: {}, events: 0, batches: 0, bytes: 0,
    limitations: ['Non-atomic paginated read of surviving records; deleted/cancelled history is incomplete.',
      'Membership is a current snapshot, not a reconstructed history of joins/exits or confirmed travel.',
      'The observation time is the export time. It must not become historical selection votes or imply earlier circle membership.',
      'Nested passengers._openid projection omits passenger contact/profile fields. Unknown or invalid identities are excluded.',
      'Reuse the exact generated files for import retries; regenerate only before any import or after explicitly resetting the version-0 baseline.'] }
  async function query(collection, offset) {
    const file = path.join(temp, `${++report.calls}.json`)
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('wechatide', ['-c', 'Codex', 'cloud_db_read_doc', '--appid', appid, '--env', env,
          '--collection-name', collection, '--projection', JSON.stringify(PROJECTION),
          '--sort', JSON.stringify([{ key: '_id', direction: 1 }]), '--limit', '500', '--offset', String(offset)], { stdio: ['ignore', fd, 'ignore'] })
        const timeout = setTimeout(() => child.kill('SIGTERM'), 45000)
        child.once('error', () => { clearTimeout(timeout); reject(new Error('readonly_cli_start_failed')) })
        child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('readonly_cli_failed')) })
      })
      const raw = fs.readFileSync(file, 'utf8'), reply = JSON.parse(raw.slice(raw.indexOf('{')))
      if (!reply.ok || !reply.result?.success || !Array.isArray(reply.result.data) || !Number.isInteger(reply.result.total)) throw new Error('invalid_readonly_reply')
      return reply.result
    } finally { fs.closeSync(fd); fs.unlinkSync(file) }
  }
  try {
    const events = []
    for (const [collection, type] of [['Carpool', 'carpool'], ['CarpoolRequest', 'request']]) {
      const first = await query(collection, 0), pages = [first]
      // Read sequentially so operation load remains bounded during live use.
      for (let offset = 500; offset < first.total; offset += 500) pages.push(await query(collection, offset))
      const rows = [...new Map(pages.flatMap(page => page.data).map(row => [row._id, row])).values()]
      const summary = { collection, firstTotal: first.total, rows: rows.length, exported: 0,
        totalsConsistent: pages.every(page => page.total === first.total) && rows.length === first.total }
      if (!summary.totalsConsistent) throw new Error('live_counts_changed_retry_export_before_import')
      for (const row of rows) {
        const result = makeBaseline(row, type, { today, observedAt })
        if (result.skip) { report.skipped[result.skip] = (report.skipped[result.skip] || 0) + 1; continue }
        try { validateBusinessEvents({ schemaVersion: 1, events: [result.event] }) } catch (_) {
          report.skipped.invalidSnapshot = (report.skipped.invalidSnapshot || 0) + 1; continue
        }
        events.push(result.event); summary.exported++
      }
      report.collections.push(summary)
    }
    const batches = packBatches(events)
    batches.forEach((batch, index) => {
      const body = JSON.stringify(batch) + '\n'
      fs.writeFileSync(path.join(output, `batch-${String(index + 1).padStart(4, '0')}.jsonl`), body, { flag: 'wx', mode: 0o600 })
      report.bytes += Buffer.byteLength(body)
    })
    report.events = events.length; report.batches = batches.length
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return report
  } finally { fs.rmdirSync(temp) }
}
if (require.main === module) main().catch(error => { process.stderr.write(`baseline_export_failed: ${error && /^[a-z0-9_]+$/i.test(error.message) ? error.message : 'redacted_error'}\n`); process.exitCode = 1 })
module.exports = { PROJECTION, normalizeRow, makeBaseline, packBatches, main }
