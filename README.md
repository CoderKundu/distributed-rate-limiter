# throttle

A rate limiter you run as a service. Every instance talks to the same Redis,
and every limit check is a single Lua script, so the limit holds no matter
how many app instances are in front of it.

Two algorithms, token bucket and sliding window log, configured per rule in
a YAML file. Use it over HTTP (`POST /check`) or drop the Express middleware
into your own app.

```
                    ┌──────────┐
   clients ──────▶  │  nginx   │  round robin
                    └────┬─────┘
            ┌────────────┼────────────┐
       ┌────▼───┐   ┌────▼───┐   ┌────▼───┐
       │ app 1  │   │ app 2  │   │ app 3  │   Node + Express, stateless
       └────┬───┘   └────┬───┘   └────┬───┘
            └────────────┼────────────┘
                         │ EVALSHA (one round trip per check)
                    ┌────▼─────────────────────┐
                    │ Redis 7                  │
                    │  token_bucket.lua        │  read, decide and write run
                    │  sliding_window.lua      │  atomically, on Redis' clock
                    └──────────────────────────┘
```

## Running it

```bash
docker compose up --build
```

That starts Redis, three app instances and nginx on `localhost:8080`.

```bash
curl -i -X POST localhost:8080/check \
  -H 'content-type: application/json' \
  -d '{"key":"user:42","rule":"login"}'
```

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4

{"allowed":true,"remaining":4,"retryAfterMs":0}
```

Once you're over the limit you get a `429` with a `Retry-After` header (in
seconds) and `retryAfterMs` in the body.

For local dev without Docker, point it at any Redis:

```bash
npm install
REDIS_URL=redis://localhost:6379 npm run dev
```

| env | default | |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | |
| `RULES_FILE` | `rules.yml` | |
| `REDIS_TIMEOUT_MS` | `100` | per command. After this the rule's failure mode kicks in |
| `PORT` | `3000` | |
| `ENABLE_NAIVE` | unset | `1` exposes `/check-naive`, which only exists for the benchmark |

## Rules

```yaml
rules:
  api-default:
    algorithm: token_bucket
    capacity: 100          # max burst
    refill_per_sec: 1.67   # ~100/min sustained
    on_redis_error: open

  login:
    algorithm: sliding_window
    limit: 5
    window_sec: 60
    on_redis_error: closed
```

The config is validated at startup, so a typo in `rules.yml` stops the
process instead of showing up as a 500 later on.

## Middleware

```ts
import { rateLimit } from './middleware.js';

app.post('/login',
  rateLimit(limiter, { rule: 'login', keyFn: (req) => req.body.email }),
  loginHandler);
```

It sets `X-RateLimit-Limit`, `X-RateLimit-Remaining` and, when it rejects a
request, `Retry-After`. `keyFn` defaults to `req.ip`.

## Token bucket vs sliding window

| | token bucket | sliding window log |
|---|---|---|
| bursts | allows up to `capacity` at once, then a steady trickle | never more than `limit` in any window |
| accuracy | exact, but "100/min" really means 100 + whatever refilled | exact over any rolling window |
| memory per key | fixed, **104 B** | one entry per request in the window: **152 B** at 1, **7.2 KB** at 100, **135 KB** at 1000 |
| 1M active keys | ~99 MB | ~7 GB if each has 100 hits in its window |
| good for | general API traffic where short bursts are fine | login, OTP, anything where "at most N" has to be strict |

The sliding window's memory cost is the real tradeoff. Each entry holds the
score plus a member string (`<ms>-<uuid>`, around 50 bytes), and past 128
entries Redis switches the sorted set from a listpack to a skiplist, which is
why bytes per entry jump from ~70 to ~135 between the 100 and 1000 rows. So
it's great for small limits like 5 logins a minute and a bad idea for
10,000 requests an hour. A sliding window *counter* (two fixed windows,
weighted) would fix that at the cost of some accuracy. That's next on the
list.

## Benchmarks

Machine: i5-11400H (6C/12T), 16 GB RAM, Windows 11, Docker Desktop (WSL2,
12 vCPU / 8 GB). Redis 7.4, Node 22, everything on one box, so these numbers
say more about relative cost than absolute capacity.

Everything is in `bench/`. With the stack up, `./bench/run.sh` runs it all.
It uses the `grafana/k6` Docker image, so you don't need k6 installed.

### Accuracy under a burst

10,000 requests from 200 concurrent k6 VUs at a 100/min limit, through nginx,
spread across the 3 instances. Same key for every request.

| implementation | admitted (10 runs) | over the limit |
|---|---|---|
| Lua sliding window | 100 every run | **0%** |
| Lua token bucket | 103 every run* | **0%** |
| naive `GET` → compare → `INCR` | 102 to 139, median 115.5 | **2% to 39%**, mean 19% |

\* The bucket keeps refilling at 1.67/s during the ~2.2s run, so its fair
ceiling is `100 + 1.67 × duration` = 103. It hit that exactly.

The naive version's number moves around a lot between runs because it
depends on how many `GET`s land between another request's `GET` and `INCR`.
Hitting Redis directly from 5 connections with 1000 in-flight requests (the
concurrency test) makes it much worse, since pipelining sends all the `GET`s
before any `INCR`.

### Latency

In-process, just `limiter.check()` against Redis, 20k sequential calls:

| | p50 | p99 |
|---|---|---|
| token bucket | 0.30 ms | 0.74 ms |
| sliding window | 0.32 ms | 0.78 ms |

Over HTTP through nginx at a steady 500 req/s for 30s:

| route | p50 | p90 | p99 |
|---|---|---|---|
| `POST /check` | 1.75 ms | 2.19 ms | 3.05 ms |
| `GET /demo` (middleware) | 1.63 ms | 1.84 ms | 2.54 ms |
| `GET /noop` (same route, no limiter) | 1.34 ms | 1.76 ms | 2.49 ms |

So the middleware adds about 0.3 ms at the median, which matches the
in-process number. At p99 the difference gets lost in HTTP and Docker
networking noise.

### Throughput

`POST /check` through nginx, closed loop, 20s per step, keys spread over 10k
users:

| VUs | req/s | p50 | p99 |
|---:|---:|---:|---:|
| 10 | 2,503 | 3.4 ms | 10.4 ms |
| 25 | 3,615 | 6.4 ms | 14.4 ms |
| 50 | 3,597 | 13.0 ms | 30.0 ms |
| 100 | 2,590 | 23.4 ms | 56.5 ms |
| 200 | 4,081 | 45.7 ms | 119.2 ms |
| 400 | 3,985 | 70.7 ms | 265.7 ms |

It tops out around 3.5 to 4k checks/s at 25 VUs. After that, extra
concurrency only adds queueing, and p99 goes past 100ms from 200 VUs. The
dip at 100 VUs came with a couple of `dial: i/o timeout` errors from k6, so
I think that's Docker Desktop's port forwarding rather than the app. Redis
isn't the bottleneck here: a single check costs it well under a
millisecond (see the in-process numbers). The ceiling is three Node
processes, nginx, k6 and Docker's network stack all sharing one laptop.

### Memory per key

`npm run bench:memory`, `MEMORY USAGE` averaged over 200 keys:

| algorithm | bytes/key | 1M keys |
|---|---:|---:|
| token bucket | 104 | 99 MB |
| sliding window, 1 in window | 152 | 145 MB |
| sliding window, 10 in window | 712 | 679 MB |
| sliding window, 100 in window | 7,240 | 6.7 GB |
| sliding window, 1000 in window | 134,925 | 126 GB |

## Design decisions

**Why Lua.** The naive limiter does `GET count` → `if count < limit` →
`INCR`. That's three steps, and between the first and the last any number
of other requests can read the same count. It isn't a theoretical problem:
the table above shows it letting through up to 39% more than the limit. A
Lua script runs atomically in Redis, so read, decide and write happen with
nothing in between. `MULTI`/`WATCH` would also work but retries under
contention, which is exactly when a rate limiter is busiest.

Scripts are loaded with `SCRIPT LOAD` at startup and called with `EVALSHA`.
The SHA is computed locally, and if Redis comes back with `NOSCRIPT` (after a
restart, failover or `SCRIPT FLUSH`) the script is reloaded and the call
retried once. There's a test for that.

**Why Redis `TIME`.** If each app server passed in `Date.now()`, the refill
math would depend on whose clock was running fast. Two instances 200ms apart
would each think a different amount of tokens had refilled. Taking the time
inside the script means there's exactly one clock. Redis 5+ replicates
script effects rather than the script itself, so calling `TIME` before a
write is allowed.

**Fail open or fail closed.** It's per rule, because the right answer
depends on the endpoint:

- **Open** (default) for general API traffic. If Redis is down, going
  without rate limiting for a while is better than taking the whole API
  down with it.
- **Closed** for login and OTP. An attacker who can knock over Redis
  shouldn't get unlimited password guesses as a reward. A login outage is
  bad, but credential stuffing is worse.

Either way, a check never waits long on Redis. The client has a 100ms
command timeout, doesn't queue commands while disconnected, and reconnects
in the background. Degraded responses leave out `X-RateLimit-Remaining`
(since we don't actually know it) and `/check` includes `"degraded": true`.

The timeout started at 50ms. The first accuracy run against the compose
stack admitted 103 instead of 100 on the sliding window, which looked like a
bug in the Lua. It wasn't: during the cold start of the burst, event loop
lag pushed a few calls past 50ms, they timed out, and the rule failed open.
Raising the timeout to 100ms, making the bench rules fail closed, and
counting degraded responses separately in the k6 script fixed the
measurement. Worth knowing if you tune the timeout down.

**Keep-alive behind nginx.** The same run also produced a few `502`s:
"connection reset by peer" in the nginx logs. Node closes idle keep-alive
sockets after 5s, and nginx sometimes reuses one right as Node closes it. The
server's `keepAliveTimeout` is now 65s, longer than nginx will ever hold one.

**If Redis were sharded.** Every check touches exactly one key, so Redis
Cluster works as is: each key lives on one shard and the script runs there.
What you'd lose is anything that needs two keys in one script, like the
sliding window counter (current + previous window). Those would need hash
tags (`rl:{rule:key}:cur`) to land on the same slot. The other thing to watch
is a single very hot key, which pins all its load on one shard no matter
how many you have.

## Tests

```bash
docker run -d -p 6379:6379 redis:7-alpine
npm test
```

Tests run against a real Redis (db 15 by default, override with
`TEST_REDIS_URL`). There's no mocked Redis anywhere, since the whole point is
how the scripts behave inside Redis.

- **algorithms**: burst up to capacity, refill rate, never refilling past
  capacity, `Retry-After` values, window expiry, the window actually
  sliding instead of resetting, TTLs, recovery after `SCRIPT FLUSH`
- **concurrency**: 1000 parallel checks over 5 connections at a limit of
  100. Both Lua versions admit exactly 100, and the naive one admits more
- **failure**: stalls Redis mid-test with `CLIENT PAUSE`, kills the
  connection with `CLIENT KILL`, and points at a port with nothing on it.
  Fail-open allows, fail-closed denies, both inside the timeout, and it
  recovers once Redis is back
- **http**: status codes, headers, validation, the middleware

CI runs typecheck, tests (against a Redis service container) and a Docker
build on every push.

## Layout

```
lua/                 the two scripts
src/
  config.ts          rules.yml parsing + validation
  scripts.ts         SCRIPT LOAD / EVALSHA / NOSCRIPT retry
  limiter.ts         picks the script, applies the failure mode
  middleware.ts      express middleware
  naive.ts           the broken version, for comparison
  app.ts, index.ts   http server
bench/
  k6/                accuracy, latency, throughput
  memory.ts          MEMORY USAGE per key
  check-latency.ts   in-process latency, no http
  run.sh
test/
```
