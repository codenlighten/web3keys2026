// k6 load test for the web3keys API. Run against a STAGING server, never production:
//   BASE=https://staging.web3keys.com k6 run deploy/loadtest.k6.js
//
// Exercises read-only + auth paths (non-custodial: no real funds move). Registration uses
// throwaway emails; clean the staging DB afterward.

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:3000';

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '1m', target: 25 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

export default function () {
  // Liveness + readiness + paymail discovery (the hot read paths).
  check(http.get(`${BASE}/healthz`), { 'healthz 200': (r) => r.status === 200 });
  check(http.get(`${BASE}/.well-known/bsvalias`), {
    'bsvalias 200': (r) => r.status === 200,
  });
  // A login attempt with bad creds (exercises auth + lockout + rate-limit paths).
  const res = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ email: `load-${__VU}@example.com`, password: 'wrongpassword' }),
    { headers: { 'content-type': 'application/json' } }
  );
  check(res, { 'login handled': (r) => r.status === 401 || r.status === 429 });
  sleep(1);
}
