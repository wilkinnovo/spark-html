#!/usr/bin/env bash
# krausest truth harness for spark-html (spark-speed-up-max.md).
#
# Paired vanilla+spark run of the official webdriver-ts harness against THIS
# repo's core (freshly built dist → tarball → impl install). The ratio table
# is the program's ledger currency; bench discipline lives in the plan §5.
#
# Usage:
#   ./run.sh [--count N] [--windowed] [--benchmark 01_ 04_ ...] [--skip-install]
# Env:
#   JFB_DIR  work clone (default ~/.cache/spark-bench/jfb — NOT /tmp: tmpfs quota)
#   SYMBOL   a symbol that must appear in the served bundle (stale-dist guard)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
JFB=${JFB_DIR:-$HOME/.cache/spark-bench/jfb}
PIN=$(cat "$HERE/jfb-pin.txt")
COUNT=6 HEADLESS="--headless" BENCH="" SKIP_INSTALL=0
while [ $# -gt 0 ]; do case "$1" in
  --count) COUNT=$2; shift 2;;
  --windowed) HEADLESS=""; shift;;
  --benchmark) shift; BENCH="--benchmark"; while [ $# -gt 0 ] && [[ "$1" != --* ]]; do BENCH="$BENCH $1"; shift; done;;
  --skip-install) SKIP_INSTALL=1; shift;;
  *) echo "unknown arg: $1"; exit 1;;
esac; done

# 0. work clone at the pinned commit (one-time)
if [ ! -d "$JFB/.git" ]; then
  git clone --depth 1 https://github.com/krausest/js-framework-benchmark "$JFB"
  (cd "$JFB" && git fetch --depth 1 origin "$PIN" && git checkout -q "$PIN") || echo "WARN: pin $PIN not checked out; using clone HEAD"
  (cd "$JFB" && npm ci --no-audit --no-fund)
  (cd "$JFB/webdriver-ts" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund && npm run compile)
  (cd "$JFB/frameworks/keyed/vanillajs" && npm ci --no-audit --no-fund && npm run build-prod)
fi

# 1. fresh core → tarball. Package entry is dist/spark.js — ALWAYS rebuild it
#    first (the G2 stale-dist trap), then install the tarball into the impl.
if [ "$SKIP_INSTALL" = 0 ]; then
  (cd "$ROOT" && node scripts/build-dist.mjs)
  TARBALL=$(cd "$ROOT/packages/spark" && npm pack --silent)
  TARBALL="$ROOT/packages/spark/$TARBALL"
  mkdir -p "$JFB/frameworks/keyed/spark-html"
  rsync -a --delete --exclude node_modules --exclude dist "$HERE/impl/" "$JFB/frameworks/keyed/spark-html/"
  (cd "$JFB/frameworks/keyed/spark-html" \
    && npm install --no-audit --no-fund --loglevel=error \
    && npm install --no-audit --no-fund --loglevel=error "$TARBALL" \
    && npm run build-prod)
  rm -f "$TARBALL"
  if [ -n "${SYMBOL:-}" ]; then
    grep -rq "$SYMBOL" "$JFB/frameworks/keyed/spark-html/dist/" \
      || { echo "FATAL: SYMBOL '$SYMBOL' not in served bundle — stale dist"; exit 1; }
    echo "served-bundle check: '$SYMBOL' present ✓"
  fi
fi

# 2. static server on 8080 (left running; kill via /tmp/jfb-server.pid)
if ! curl -sf http://localhost:8080/ >/dev/null 2>&1; then
  (cd "$JFB" && nohup npm start >/tmp/jfb-server.log 2>&1 & echo $! >/tmp/jfb-server.pid)
  for _ in $(seq 1 30); do curl -sf http://localhost:8080/ >/dev/null 2>&1 && break; sleep 1; done
  curl -sf http://localhost:8080/ >/dev/null || { echo "FATAL: server did not start"; exit 1; }
fi

# 3. the paired run — vanilla + spark in ONE session (the only ratio we trust)
(cd "$JFB/webdriver-ts" && npm run bench -- \
  --framework keyed/spark-html keyed/vanillajs \
  --count "$COUNT" $HEADLESS $BENCH \
  --chromeBinary /snap/bin/chromium)

# 4. ratio table
node "$HERE/table.mjs" "$JFB/webdriver-ts/results"
