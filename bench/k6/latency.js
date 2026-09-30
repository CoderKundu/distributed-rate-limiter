// Steady, moderate load so we're measuring latency and not queueing.
//
//   k6 run -e TARGET=check bench/k6/latency.js   POST /check directly
//   k6 run -e TARGET=demo  bench/k6/latency.js   GET /demo (behind the middleware)
//   k6 run -e TARGET=noop  bench/k6/latency.js   GET /noop (same route, no limiter)
//
// "added by the middleware" = demo minus noop.

import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const TARGET = __ENV.TARGET || 'check';

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 500),
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(99)', 'max'],
};

const json = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  // spread over 1000 keys so we aren't just hammering one hash slot
  const user = `u${Math.floor(Math.random() * 1000)}`;
  if (TARGET === 'check') {
    http.post(`${BASE}/check`, JSON.stringify({ key: user, rule: 'loadtest' }), json);
  } else {
    // /demo uses api-default, which will start 429ing for a hot user. that's
    // fine, a 429 goes through the exact same code path.
    http.get(`${BASE}/${TARGET}`, { headers: { 'x-user-id': user } });
  }
}

export function handleSummary(data) {
  const d = data.metrics.http_req_duration.values;
  const f = (x) => x.toFixed(2);
  return {
    stdout: `target=${TARGET} rps=${f(data.metrics.http_reqs.values.rate)} ` +
      `p50=${f(d['p(50)'])}ms p90=${f(d['p(90)'])}ms p99=${f(d['p(99)'])}ms max=${f(d.max)}ms\n`,
  };
}
