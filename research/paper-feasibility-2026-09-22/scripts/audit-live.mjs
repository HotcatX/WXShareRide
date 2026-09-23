// Read-only audit. Outputs aggregates only; raw projected rows are never retained.
// Usage: node audit-live.mjs --appid APPID --env ENV > evidence/current-data.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getRideDateTime, parseRideDateTime } = require('../../../utils/rideTime.js');
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
if (!args.includes('--appid') || !args.includes('--env')) throw new Error('Explicit --appid and --env required');
const appid = arg('--appid'), env = arg('--env');
const startedAt = new Date().toISOString();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-research-aggregate-'));
fs.chmodSync(temporary, 0o700);
let call = 0;

async function query(collection, projection, offset = 0, limit = 500) {
  // A regular file avoids the current CLI's truncated pipe output on large pages.
  // It is mode 0600 inside a mode 0700 temporary directory and removed in finally.
  const file = path.join(temporary, `${++call}.json`);
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    const command = ['-c', 'Codex', 'cloud_db_read_doc', '--appid', appid, '--env', env,
      '--collection-name', collection, '--projection', JSON.stringify(projection),
      '--sort', JSON.stringify([{ key: '_id', direction: 1 }]),
      '--limit', String(limit), '--offset', String(offset)];
    await new Promise((resolve, reject) => {
      const child = spawn('wechatide', command, { stdio: ['ignore', descriptor, 'ignore'] });
      const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Read failed: ${collection}, code ${code}`)); });
    });
    const raw = fs.readFileSync(file, 'utf8');
    const payload = JSON.parse(raw.slice(raw.indexOf('{')));
    if (!payload.ok || !payload.result?.success || !Array.isArray(payload.result.data)) throw new Error(`Invalid read result: ${collection}`);
    return payload.result;
  } finally { fs.closeSync(descriptor); fs.rmSync(file, { force: true }); }
}

async function readAll(collection, projection) {
  const first = await query(collection, projection);
  const results = [first];
  const offsets = Array.from({ length: Math.max(0, Math.ceil(first.total / 500) - 1) }, (_, i) => (i + 1) * 500);
  for (let i = 0; i < offsets.length; i += 3) {
    const batch = await Promise.allSettled(offsets.slice(i, i + 3).map(offset => query(collection, projection, offset)));
    const failure = batch.find(x => x.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...batch.map(x => x.value));
  }
  const all = results.flatMap(x => x.data);
  const rows = [...new Map(all.map(x => [x._id, x])).values()];
  return { rows, audit: { collection, totalAtFirstRead: first.total, totalsDuringRead: [...new Set(results.map(x => x.total))], fetchedRows: all.length, distinctRows: rows.length, consistentCounts: results.every(x => x.total === first.total) && rows.length === first.total } };
}
const increment = (object, key, n = 1) => object[key] = (object[key] || 0) + n;
const dateMs = x => typeof x === 'number' ? x : x && typeof x === 'object' && '$date' in x ? Number(x.$date) : Date.parse(x || '');
const percent = (n, d) => d ? Math.round(10000 * n / d) / 100 : null;
function summary(values) {
  const x = values.filter(Number.isFinite).sort((a, b) => a - b);
  return x.length ? { n: x.length, min: x[0], p25: x[Math.floor((x.length - 1) * .25)], median: x[Math.floor((x.length - 1) * .5)], p75: x[Math.floor((x.length - 1) * .75)], p90: x[Math.floor((x.length - 1) * .9)], p95: x[Math.floor((x.length - 1) * .95)], max: x.at(-1) } : { n: 0 };
}
function area(value) {
  const x = String(value || '').toLowerCase();
  if (/fort\s*lee|李堡/.test(x)) return 'Fort Lee';
  if (/哥大|columbia/.test(x)) return 'Columbia';
  if (/ewr|newark|纽瓦克/.test(x)) return 'EWR';
  if (/jfk|肯尼迪/.test(x)) return 'JFK';
  if (/lga|laguardia|拉瓜迪亚/.test(x)) return 'LGA';
  if (/flushing|法拉盛/.test(x)) return 'Flushing';
  return x ? 'Other' : 'Missing';
}

try {
  const offerRead = await readAll('Carpool', { _id: 1, _openid: 1, createdAt: 1, departureAtMs: 1, firstDepartureDate: 1, firstDepartureTime: 1, departures: 1, destinations: 1, status: 1, passengerCount: 1, availSeatNum: 1, 'passengers._openid': 1, 'passengers.joinedAt': 1 });
  const rows = offerRead.rows;
  const now = Date.now(), today = getRideDateTime(now).date;
  const states = {}, routeCounts = {}, monthly = {}, createdMonthly = {}, hosts = {}, pairs = {}, dailyCore = {}, coreTimetable = {}, departuresPerRecord = {};
  const members = new Set(), created = [], lead = [], joinLead = [], joinLag = [], septemberLead = [], septemberJoinLead = [];
  let withMembers = 0, membershipCount = 0, past = 0, joinedTimes = 0, joinAfterDeparture = 0, missingJoin = 0, seatConsistent = 0, seatEligible = 0, coreCount = 0;
  let repeatedRows = 0, previousCoreMatched = 0;
  const schedules = new Set();
  for (const r of rows) {
    increment(states, r.status || 'Missing');
    const d = r.departures?.[0] || {}, day = r.firstDepartureDate || d.date, clock = r.firstDepartureTime || d.time;
    const departure = Number(r.departureAtMs) || parseRideDateTime(day, clock);
    const creation = dateMs(r.createdAt), month = String(day || 'Missing').slice(0, 7);
    const route = `${area(d.address)} -> ${area(r.destinations?.[0]?.address)}`;
    const core = route === 'Fort Lee -> Columbia' || route === 'Columbia -> Fort Lee';
    increment(routeCounts, route); increment(monthly, month); increment(departuresPerRecord, (r.departures || []).length);
    if (r._openid) increment(hosts, r._openid);
    if (Number.isFinite(creation)) { created.push(creation); increment(createdMonthly, getRideDateTime(creation).date.slice(0, 7)); }
    if (departure < now) past++;
    if (Number.isFinite(departure) && Number.isFinite(creation) && departure >= creation) { lead.push((departure - creation) / 36e5); if (month === '2026-09') septemberLead.push((departure - creation) / 36e5); }
    const persons = (r.passengers || []).filter(x => x?._openid);
    if (persons.length) withMembers++;
    membershipCount += persons.length;
    if (Number.isInteger(r.passengerCount) && Number.isInteger(r.availSeatNum) && r.passengerCount >= 0 && r.availSeatNum >= 0) { seatEligible++; if (r.passengerCount - r.availSeatNum === persons.length) seatConsistent++; }
    if (core) {
      coreCount++;
      if (day < today) { increment(dailyCore, day); if (persons.length) previousCoreMatched++; }
      if (day < today && month === '2026-09') { const key = `${day}|${route}`; (coreTimetable[key] ||= []).push(departure); }
    }
    const scheduleKey = `${r._openid}|${day}|${clock}|${route}`;
    if (schedules.has(scheduleKey)) repeatedRows++; else schedules.add(scheduleKey);
    for (const p of persons) {
      members.add(p._openid); if (r._openid) increment(pairs, `${r._openid}|${p._openid}`);
      const j = dateMs(p.joinedAt);
      if (!Number.isFinite(j)) { missingJoin++; continue; }
      joinedTimes++;
      if (Number.isFinite(creation) && j >= creation) joinLag.push((j - creation) / 36e5);
      if (Number.isFinite(departure) && j <= departure) { joinLead.push((departure - j) / 36e5); if (month === '2026-09') septemberJoinLead.push((departure - j) / 36e5); } else if (j > departure) joinAfterDeparture++;
    }
  }
  const topHosts = Object.values(hosts).sort((a, b) => b - a), pairCounts = Object.values(pairs), repeatedPairs = pairCounts.filter(n => n > 1);
  const nearest = [];
  for (const schedule of Object.values(coreTimetable)) { schedule.sort((a, b) => a - b); for (let i = 0; i < schedule.length; i++) { const before = i ? schedule[i] - schedule[i - 1] : Infinity, after = i + 1 < schedule.length ? schedule[i + 1] - schedule[i] : Infinity; if (Number.isFinite(Math.min(before, after))) nearest.push(Math.min(before, after) / 60000); } }
  const septemberDays = Object.entries(dailyCore).filter(([day]) => day >= '2026-09-01' && day < today).map(([, n]) => n);
  const offer = { count: rows.length, states, plannedMonthly: monthly, createdMonthlyNY: createdMonthly, createdDateRangeUTC: [new Date(Math.min(...created)).toISOString(), new Date(Math.max(...created)).toISOString()], departuresPerRecord, broadRoutes: routeCounts, coreCorridorCount: coreCount, coreCorridorPercent: percent(coreCount, rows.length), uniquePublishingAccounts: topHosts.length, top10PublishingPercent: percent(topHosts.slice(0, 10).reduce((a, b) => a + b, 0), rows.length), creationLeadHours: summary(lead), septemberCreationLeadHours: summary(septemberLead), membershipsWithJoinTimes: joinedTimes, missingJoinTimes: missingJoin, joinsAfterScheduledDeparture: joinAfterDeparture, joinLeadHours: summary(joinLead), septemberJoinLeadHours: summary(septemberJoinLead), joinAfterCreationHours: summary(joinLag), recordsWithCurrentMembers: withMembers, currentPassengerMemberships: membershipCount, uniqueCurrentPassengerAccounts: members.size, uniqueDriverPassengerPairs: pairCounts.length, repeatedPairCount: repeatedPairs.length, membershipsInRepeatedPairs: repeatedPairs.reduce((a, b) => a + b, 0), repeatedMembershipPercent: percent(repeatedPairs.reduce((a, b) => a + b, 0), membershipCount), samePublisherDateTimeBroadRouteDuplicateRows: repeatedRows, recordsPastPlannedTime: past, capacityCheck: { eligible: seatEligible, accountMembersEqualCapacityMinusRemaining: seatConsistent }, septemberCompletedCalendarDaysWithCoreSupply: septemberDays.length, septemberCoreOffersPerObservedActiveDay: summary(septemberDays), septemberCoreSameDirectionNearestOfferGapMinutes: summary(nearest), septemberCoreOffersWithNeighbourWithin15Minutes: nearest.filter(x => x <= 15).length, septemberCoreOffersWithNeighbourWithin30Minutes: nearest.filter(x => x <= 30).length };
  console.log(JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), timeZone: 'America/New_York', queryAudit: offerRead.audit, definitions: ['Live reads are not an atomic frozen snapshot. Count consistency does not prove absence of edits.', 'Broad OD categories use string aliases, not geospatial trip equivalence.', 'Members are those retained in surviving records; exited/deleted relationships are absent.', 'All observed capacity and pairing statistics describe platform records, not independently confirmed travel.', 'Nearest departure gaps describe listed supply only; they do not establish missing demand or willingness to shift.', 'Repeated-pair statistics use the whole observed window and must not be used as pre-treatment predictive features.'], offer }, null, 2));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
