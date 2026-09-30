#!/usr/bin/env bash
# Runs every benchmark against the compose stack. Needs `docker compose up -d`
# first. Uses the k6 docker image so you don't have to install k6.
#
#   ./bench/run.sh              all of it
#   ./bench/run.sh accuracy     just one section
set -euo pipefail
cd "$(dirname "$0")/.."

# k6 runs in a container, so localhost is the host machine
BASE=${BASE_URL:-http://host.docker.internal:8080}
# git bash on windows mangles the volume path without these two
export MSYS_NO_PATHCONV=1
HERE=$(pwd -W 2>/dev/null || pwd)
K6="docker run --rm -i --add-host=host.docker.internal:host-gateway -v $HERE/bench/k6:/scripts grafana/k6:latest run -q"
what=${1:-all}

if [[ $what == all || $what == accuracy ]]; then
  echo "== accuracy (10k requests, 100/min limit, 3 instances) =="
  for i in 1 2 3; do
    $K6 -e BASE_URL=$BASE -e MODE=lua -e RULE=bench-window /scripts/accuracy.js
    $K6 -e BASE_URL=$BASE -e MODE=lua -e RULE=bench-bucket /scripts/accuracy.js
    $K6 -e BASE_URL=$BASE -e MODE=naive /scripts/accuracy.js
  done
fi

if [[ $what == all || $what == latency ]]; then
  echo "== latency (500 rps, 30s) =="
  for t in check demo noop; do
    $K6 -e BASE_URL=$BASE -e TARGET=$t /scripts/latency.js
  done
  echo "-- in-process, no http --"
  REDIS_URL=${REDIS_URL:-redis://localhost:6379} npx tsx bench/check-latency.ts
fi

if [[ $what == all || $what == throughput ]]; then
  echo "== throughput =="
  for vus in 10 25 50 100 200 400; do
    $K6 -e BASE_URL=$BASE -e VUS=$vus /scripts/throughput.js
  done
fi

if [[ $what == all || $what == memory ]]; then
  echo "== memory per key =="
  REDIS_URL=${REDIS_URL:-redis://localhost:6379} npx tsx bench/memory.ts
fi
