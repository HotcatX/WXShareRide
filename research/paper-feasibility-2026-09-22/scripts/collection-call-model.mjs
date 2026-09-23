// Planning scenarios only: no network, credentials, or production data access.
// Run with Node.js; --write saves a local JSON evidence file next to this script.
import { writeFileSync } from 'node:fs';

const assumptions = {
  daysPerMonth: 30,
  eventsPerSession: 30,
  bytesPerSession: 50000,
  batchesPerSessionRange: [1, 3],
  retryExtraPercent: 10,
  hotRetentionDays: 14,
  hotSpacePlanningMultiplier: 3,
  workersCpuMsPerRequest: 20,
  cloudbaseMeteredUnitsPerBatchSensitivity: [3, 6],
  cloudbaseCallPriceCnyPer10000: 0.5,
  scfMemoryGB: 0.25,
  scfBilledSecondsPerRequest: 0.2,
  scfPriceCnyPerGBSecond: 0.00011108,
  scfPriceCnyPer10000Requests: 0.0133,
  cosOperationsPerBatchPlanning: 6,
  cosGuangzhouExampleCnyPer10000Operations: 0.01,
};
const scenarios = [100, 500, 2000].map(sessionsPerDay => {
  const sessionsPerMonth = sessionsPerDay * assumptions.daysPerMonth;
  const requests = assumptions.batchesPerSessionRange.map(b =>
    Math.ceil(sessionsPerMonth * b * (100 + assumptions.retryExtraPercent) / 100));
  return {
    sessionsPerDay,
    eventsPerMonth: sessionsPerMonth * assumptions.eventsPerSession,
    oneBatchPerSessionMonthlyRequestsBeforeRetries: sessionsPerMonth,
    monthlyCollectorRequestsWithRetriesRange: requests,
    monthlyNewPayloadDecimalGB: sessionsPerMonth * assumptions.bytesPerSession / 1e9,
    annualNewPayloadDecimalGB: sessionsPerDay * 365 * assumptions.bytesPerSession / 1e9,
    hotPayloadDecimalGB: sessionsPerDay * assumptions.hotRetentionDays * assumptions.bytesPerSession / 1e9,
    hotSpaceBudgetDecimalGB: sessionsPerDay * assumptions.hotRetentionDays * assumptions.bytesPerSession * assumptions.hotSpacePlanningMultiplier / 1e9,
    workersCpuMsRange: requests.map(n => n * assumptions.workersCpuMsPerRequest),
    scfFunctionOnlyCnyRange: requests.map(n => Number((n * (
      assumptions.scfMemoryGB * assumptions.scfBilledSecondsPerRequest * assumptions.scfPriceCnyPerGBSecond +
      assumptions.scfPriceCnyPer10000Requests / 10000
    )).toFixed(6))),
    cosReadWriteOnlyCnyRange: requests.map(n => Number((n *
      assumptions.cosOperationsPerBatchPlanning * assumptions.cosGuangzhouExampleCnyPer10000Operations / 10000
    ).toFixed(6))),
    cloudbaseAdditionalCallOnlyCnySensitivity: [
      requests[0] * assumptions.cloudbaseMeteredUnitsPerBatchSensitivity[0] * assumptions.cloudbaseCallPriceCnyPer10000 / 10000,
      requests[1] * assumptions.cloudbaseMeteredUnitsPerBatchSensitivity[1] * assumptions.cloudbaseCallPriceCnyPer10000 / 10000,
    ].map(n => Math.round((n + Number.EPSILON) * 100) / 100),
  };
});
const result = {
  status: 'hypothetical-not-measured',
  units: 'Decimal KB/GB; requests are not CloudBase billing units or active users.',
  assumptions,
  limitations: [
    'One observed day does not establish the recurring baseline.',
    '3–6 CloudBase metered units per batch is sensitivity input, not verified billing semantics.',
    'CPU 20ms and 3x hot space are engineering assumptions, not benchmarks or provider multipliers.',
    'Payload counts exclude business outbox, SQL/index overhead, copies, protocol overhead and backup; no compression credit.',
    'Request ranges exclude auth refresh, business export, withdrawal, archive jobs and monitoring.',
    'CloudBase fee sensitivity assumes incremental calls are beyond the included quota; excludes other resources.',
    'Independent collection does not remove existing CloudBase business calls.',
    'SCF uses 256MiB and 200ms billed duration as assumptions, including waiting; this is not Workers CPU time.',
    'SCF function estimates exclude response/outbound traffic, COS capacity, logs, state/withdrawal jobs, domain and backups.',
    'COS 6 operations per batch is a planning input, not a verified implementation; rate is the official Guangzhou billing example, subject to region and current purchase pricing.',
  ],
  screenshotBaselineScenarioOnly: {
    observedTodayCalls: 47700,
    monthlyIncludedCalls: 200000,
    monthlyIfSameDaily: 47700 * 30,
    callOnlyOverageCnyIfSameDaily: (47700 * 30 - 200000) * 0.5 / 10000,
  },
  scenarios,
};
const json = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--write')) {
  writeFileSync(new URL('../evidence/collection-call-scenarios.json', import.meta.url), json);
}
process.stdout.write(json);
