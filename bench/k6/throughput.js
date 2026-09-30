// Closed-loop load at a fixed number of VUs. Run it at increasing VUS
// (see bench/throughput.sh) and watch where p99 falls over.

import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const VUS = Number(__ENV.VUS || 50);

export const options = {
  vus: VUS,
  duration: __ENV.DURATION || '20s',
  summaryTrendStats: ['p(50)', 'p(99)'],
};

const params = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  const key = `u${Math.floor(Math.random() * 10000)}`;
  http.post(`${BASE}/check`, JSON.stringify({ key, rule: 'loadtest' }), params);
}

export function handleSummary(data) {
  const d = data.metrics.http_req_duration.values;
  const failed = data.metrics.http_req_failed.values.rate;
  return {
    stdout: `vus=${VUS} rps=${data.metrics.http_reqs.values.rate.toFixed(0)} ` +
      `p50=${d['p(50)'].toFixed(2)}ms p99=${d['p(99)'].toFixed(2)}ms failed=${(failed * 100).toFixed(2)}%\n`,
  };
}
