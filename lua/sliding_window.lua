-- KEYS[1]  window key (sorted set)
-- ARGV[1]  window size in ms
-- ARGV[2]  limit
-- ARGV[3]  unique request id (so two hits in the same ms don't collide)
--
-- returns { allowed (0/1), remaining, retry after ms }

local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])

local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return { 1, limit - count - 1, 0 }
end

-- full. the next slot opens when the oldest entry falls out of the window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return { 0, 0, math.max(1, tonumber(oldest[2]) + window - now) }
