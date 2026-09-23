// Read-only address-distribution audit. Keeps aggregate categories, never raw addresses.
// Usage: node audit-places.mjs --appid APPID --env ENV > evidence/place-distribution.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getRideDateTime, shiftRideDate } = require('../../../utils/rideTime.js');
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
if (!args.includes('--appid') || !args.includes('--env')) throw Error('Explicit appid/env required');
const appid = arg('--appid'), env = arg('--env');
const startedAt = new Date().toISOString(), today = getRideDateTime().date;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkx-place-audit-'));
fs.chmodSync(temp, 0o700);
let calls = 0;
const inc = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
function classify(value) {
  const s = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!s) return 'missing';
  if (/fort\s*lee|李堡/.test(s)) return 'fort_lee';
  if (/columbia|哥大|哥伦比亚大学/.test(s)) return 'columbia';
  if (/(?:^|[^a-z])jfk(?:$|[^a-z])|john\s*f\.?\s*kennedy|肯尼迪/.test(s)) return 'jfk';
  if (/(?:^|[^a-z])lga(?:$|[^a-z])|la\s*guardia|拉瓜[迪地]亚/.test(s)) return 'lga';
  if (/(?:^|[^a-z])ewr(?:$|[^a-z])|newark.*(?:airport|terminal)|纽瓦克.*(?:机场|航站)|newark\s*liberty/.test(s)) return 'ewr_explicit';
  if (/^(?:纽瓦克|newark)$/.test(s)) return 'newark_legacy_ambiguous';
  if (/flushing|法拉盛/.test(s)) return 'flushing';
  if (/(?:^|[^a-z])jsq(?:$|[^a-z])|journal[\s-]*square|泽西广场/.test(s)) return 'jsq';
  if (/(?:^|[^a-z])lic(?:$|[^a-z])|long\s*island\s*city|长岛市/.test(s)) return 'lic';
  if (/newark|纽瓦克/.test(s)) return 'newark_other_ambiguous';
  if (/newport|纽波特/.test(s)) return 'newport';
  if (/jersey\s*city|泽西市/.test(s)) return 'jersey_city_other';
  if (/hoboken|霍博肯/.test(s)) return 'hoboken';
  if (/edgewater|艾吉沃特/.test(s)) return 'edgewater';
  if (/manhattan|曼哈顿/.test(s)) return 'manhattan_other';
  if (/brooklyn|布鲁克林/.test(s)) return 'brooklyn';
  if (/queens|皇后区/.test(s)) return 'queens_other';
  if (/new\s*york|纽约/.test(s)) return 'new_york_unspecified';
  return 'other_unclassified';
}
async function query(collection, offset = 0) {
  const file = path.join(temp, `${++calls}.json`), fd = fs.openSync(file, 'wx', 0o600);
  const projection = { _id: 1, 'departures.address': 1, 'departures.date': 1,
    'destinations.address': 1, createdAt: 1, status: 1, cityKey: 1 };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('wechatide', ['-c','Codex','cloud_db_read_doc','--appid',appid,'--env',env,
        '--collection-name',collection,'--projection',JSON.stringify(projection),
        '--sort',JSON.stringify([{key:'_id',direction:1}]),'--limit','500','--offset',String(offset)],
        {stdio:['ignore',fd,'ignore']});
      const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
      child.on('error', e => {clearTimeout(timeout);reject(e);});
      child.on('close', code => {clearTimeout(timeout);code===0?resolve():reject(Error(`read_failed_${collection}_${code}`));});
    });
    const raw=fs.readFileSync(file,'utf8'), reply=JSON.parse(raw.slice(raw.indexOf('{')));
    if(!reply.ok || !reply.result?.success || !Array.isArray(reply.result.data)) throw Error('invalid_reply');
    return reply.result;
  } finally {fs.closeSync(fd);fs.unlinkSync(file);}
}
function blank() { return { records:0, origins:{}, destinations:{}, touchedTrips:{}, firstOD:{}, allEndpointOccurrences:{}, statuses:{}, cityKeys:{}, multiDepartureRecords:0, multiDestinationRecords:0 }; }
function accumulate(out,row) {
  out.records++;
  const deps=Array.isArray(row.departures)?row.departures:[], dests=Array.isArray(row.destinations)?row.destinations:[];
  const origins=deps.length?deps.map(p=>classify(p?.address)):['missing'];
  const destinations=dests.length?dests.map(p=>classify(p?.address)):['missing'];
  inc(out.origins,origins[0]);inc(out.destinations,destinations[0]);inc(out.firstOD,`${origins[0]}→${destinations[0]}`);
  for (const place of new Set([...origins,...destinations])) inc(out.touchedTrips,place);
  for (const place of [...origins,...destinations]) inc(out.allEndpointOccurrences,place);
  inc(out.statuses,String(row.status || 'unknown'));inc(out.cityKeys,String(row.cityKey || 'legacy_missing'));
  if(deps.length>1)out.multiDepartureRecords++;
  if(dests.length>1)out.multiDestinationRecords++;
}
async function audit(collection) {
  const first=await query(collection), pages=[first];
  for(let offset=500;offset<first.total;offset+=1000){
    const offsets=[offset,offset+500].filter(x=>x<first.total);
    const results=await Promise.allSettled(offsets.map(x=>query(collection,x)));
    for(const result of results){if(result.status==='rejected')throw result.reason;pages.push(result.value);}
  }
  const fetched=pages.flatMap(x=>x.data),rows=[...new Map(fetched.map(x=>[x._id,x])).values()];
  const windows={allRetained:blank(),pastScheduled:blank(),last90ScheduledDays:blank(),last30ScheduledDays:blank()};
  const ninety=shiftRideDate(today,-90), thirty=shiftRideDate(today,-30);
  let missingServiceDate=0, firstDate=null,lastDate=null;
  for(const row of rows){
    accumulate(windows.allRetained,row);
    const date=row.departures?.[0]?.date;
    if(typeof date!=='string'||!/^20\d\d-\d\d-\d\d$/.test(date)){missingServiceDate++;continue;}
    if(!firstDate||date<firstDate)firstDate=date;if(!lastDate||date>lastDate)lastDate=date;
    if(date<today){accumulate(windows.pastScheduled,row);if(date>=ninety)accumulate(windows.last90ScheduledDays,row);if(date>=thirty)accumulate(windows.last30ScheduledDays,row);}
  }
  return {collection,totalAtFirstRead:first.total,totalsDuringRead:[...new Set(pages.map(x=>x.total))],
    fetched:fetched.length,distinct:rows.length,countsConsistent:rows.length===first.total&&pages.every(x=>x.total===first.total),
    missingServiceDate,scheduledRange:[firstDate,lastDate],windows};
}
try {
  const collections=[];
  for(const name of ['Carpool','CarpoolRequest'])collections.push(await audit(name));
  console.log(JSON.stringify({startedAt,finishedAt:new Date().toISOString(),today,timeZone:'America/New_York',calls,
    definitions:['Surviving records, not all historical demand, selections, completed rides or independent users.',
      'Non-atomic live paginated reads; matching counts do not rule out concurrent edits.',
      'Origins/destinations/firstOD use the first endpoint; touchedTrips deduplicates a category within a document; allEndpointOccurrences counts every endpoint.',
      'Past/last30/last90 use first scheduled date before today; a past scheduled date does not prove travel.',
      'Explicit EWR is separate from bare Newark/纽瓦克 and ambiguous city addresses; no raw address or account is retained.',
      'Classification is a versioned heuristic for planning, not exact pickup-point equivalence.'],
    taxonomyVersion:'place-audit-20260923-v1',collections},null,2));
} finally {fs.rmdirSync(temp);}
