#!/bin/bash
# Gated staging deploy (COORDINATOR_HANDOFF "Pushing and deploying staging"). Usage, from the repo root:
#   scripts/cranl/deploy-staging-gated.sh 0180
# where 0180 is the newest migration on main. It stops before migrating unless the new API container holds that file and
# the ledger pre-check counts 0, retries a failed API build up to three times, and fails if the web build is not new.
set -u
# A deploy with no new migration stops at "not applied" (migrate answers applied: []): use the manual steps for that.
M="${1:?newest migration number on main, e.g. 0180}"
cd "$(dirname "$0")"
D="python3 deploy-staging.py"
stop(){ echo "STOP: $1"; python3 deploy-staging.py unset | cut -c1-100; python3 deploy-staging.py restart | cut -c1-60; exit 1; }
START=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "start $START"
$D connect | cut -c1-90
for b in 1 2 3; do o=$($D deploy-api 2>&1); echo "$o" | cut -c1-90 | head -1; st=$(echo "$o" | tail -1 | cut -d' ' -f1); echo "api build $b: $st"; [ "$st" = failed ] || break; sleep 20; done
for i in $(seq 1 30); do m=$($D run 'ls /srv/migrations | sort | tail -1' 2>&1 | grep -E '^0[0-9]{3}_' | tail -1); echo "$(date -u +%T) $m"; case "$m" in "$M"*) break;; esac; sleep 45; done
case "$m" in "$M"*) ;; *) stop "new API never appeared";; esac
c=$($D run "echo $(base64 -w0 ledger-precheck.js) | base64 -d > /tmp/count.js && cd /srv && NODE_PATH=/srv/node_modules node /tmp/count.js 2>&1" 90 2>&1 | grep -oE 'mismatch=[0-9]+|count-failed [A-Za-z0-9]+' | head -1); echo "pre-check: $c"
[ "$c" = "mismatch=0" ] || stop "pre-check did not return mismatch=0"
o=$($D run 'test -n "$DATABASE_ADMIN_URL" && node /srv/migrate.cjs' 600 2>&1); echo "$o" | grep -oE '"applied":\[[^]]*\]'; echo "$o" | grep -q "$M" || stop "$M not applied: $(echo "$o" | tail -2 | cut -c1-160)"
v=$($D run 'node /srv/migrate.cjs --verify' 90 2>&1); echo "$v" | grep -oE '"ok":[a-z]+'; echo "$v" | grep -q '"ok":true' || stop "verify failed"
$D unset | cut -c1-110
$D restart | cut -c1-60
# Web: CranL may already be building it (a push can start a deploy, which answers ours 409 deployment_in_progress), so
# wait for the app to settle, then deploy, and accept only a deployment newer than this script's start.
W=
webstatus() { python3 - <<'P'
from cranl_api import call
s,r=call("GET","/api/v1/apps/c247f061-835f-4caa-95b4-82c6b382c13d"); print(r.get("app",r).get("status"))
P
}
for t in 1 2 3; do
  for i in $(seq 1 45); do [ "$(webstatus)" != deploying ] && break; sleep 20; done
  python3 - <<'P'
from cranl_api import call
try:
    s,r=call("POST","/api/v1/apps/c247f061-835f-4caa-95b4-82c6b382c13d/deploy",{"wait":False},timeout=90); print("deploy-web",s)
except Exception as e: print("call dropped",type(e).__name__)
P
  for i in $(seq 1 30); do r=$(python3 - <<'P'
from cranl_api import call
s,r=call("GET","/api/v1/apps/c247f061-835f-4caa-95b4-82c6b382c13d/deployments?limit=1")
d=(r.get("deployments") or r.get("items") or r.get("data"))[0]
print(d.get("status"),d.get("created_at"))
P
); set -- $r; if [[ "$2" > "$START" ]]; then case "$1" in succeeded) W=ok; break;; failed) break;; esac; fi; sleep 20; done
  echo "web try $t: $r"
  [ "$W" = ok ] && break
done
[ "$W" = ok ] || { echo "WEB NOT CONFIRMED NEW"; exit 3; }
sleep 45
for u in https://questify-api-staging-3ez01s.cranl.net/readyz https://questify.nafes.com/en/sign-in https://questify.nafes.com/ar/sign-in https://questify.nafes.com/en/console; do echo "$(curl -s -o /dev/null -m 30 -w '%{http_code}' $u) $u"; done
$D run 'printenv DATABASE_ADMIN_URL >/dev/null && echo HAS-ADMIN || echo no-admin' 2>&1 | grep -E 'admin|ADMIN'
echo FINISHED
