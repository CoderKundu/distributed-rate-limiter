-- KEYS[1]  bucket key
-- ARGV[1]  capacity
-- ARGV[2]  refill rate, tokens per ms
--
-- returns { allowed (0/1), tokens left (floored), retry after ms }

local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])

-- use redis' clock, not the caller's. app servers drift, redis is the one
-- thing every instance agrees on.
local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

local b      = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or capacity
local ts     = tonumber(b[2]) or now

tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local allowed = 0
if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- once it's been idle long enough to refill completely the key carries no
-- information, so let it expire
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate))

local retry = 0
if allowed == 0 then
  retry = math.ceil((1 - tokens) / rate)
end

-- lua numbers get truncated to ints on the way out anyway, floor explicitly
return { allowed, math.floor(tokens), retry }
