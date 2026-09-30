// Fires a burst at a 100/min limit through nginx (3 instances) and counts
// how many got through.
//
//   k6 run -e MODE=lua    bench/k6/accuracy.js
//   k6 run -e MODE=naive  bench/k6/accuracy.js
//   k6 run -e MODE=lua -e RULE=bench-bucket bench/k6/accuracy.js

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const MODE = __ENV.MODE || 'lua';
const RULE = __ENV.RULE || 'bench-window';
const TOTAL = Number(__ENV.TOTAL || 10000);

const admitted = new Counter('admitted');
const rejected = new Counter('rejected');
const errors = new Counter('errors');

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 200),
      iterations: TOTAL,
      maxDuration: '2m',
    },
  },
  summaryTrendStats: ['p(50)', 'p(99)'],
};

// setup runs once, so every VU gets the same fresh key
export function setup() {
  return { key: `acc-${MODE}-${Date.now()}` };
}

export default function ({ key }) {
  const url = MODE === 'naive' ? `${BASE}/check-naive` : `${BASE}/check`;
  const body = MODE === 'naive' ? { key, limit: 100, windowSec: 60 } : { key, rule: RULE };

  const res = http.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    responseCallback: http.expectedStatuses(200, 429),
  });

  if (res.status === 200) admitted.add(1);
  else if (res.status === 429) rejected.add(1);
  else errors.add(1);
}

export function handleSummary(data) {
  const n = (m) => (data.metrics[m] ? data.metrics[m].values.count : 0);
  const a = n('admitted');
  const line =
    `mode=${MODE} rule=${MODE === 'naive' ? '-' : RULE} requests=${TOTAL} ` +
    `admitted=${a} rejected=${n('rejected')} errors=${n('errors')} ` +
    `over_admitted=${(((a - 100) / 100) * 100).toFixed(1)}%\n`;
  return { stdout: line };
}
