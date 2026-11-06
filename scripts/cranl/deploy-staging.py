"""Staging deploy steps, used from the RUNBOOK's "Database and deploy". Run from scripts/cranl: python deploy-staging.py <step>."""
import json
import sys
from cranl_api import call, clean, run_logged

API = "7fc67d79-a5e5-4ecf-b366-dd7e9eeabd70"
WEB = "c247f061-835f-4caa-95b4-82c6b382c13d"
DB = "20df9fd7-afd5-4793-984e-a17a0a2858d2"


def show(tag, s, r):
    print(tag, s, json.dumps(clean(r))[:700])


def latest(app):
    s, r = call("GET", f"/api/v1/apps/{app}/deployments?limit=1")
    d = (r.get("deployments") or r.get("items") or r.get("data"))[0]
    print(d.get("status"), d.get("created_at"))


step = sys.argv[1]
if step == "connect":
    show("connect", *call("POST", f"/api/v1/databases/{DB}/connect", {"app_id": API, "variable": "DATABASE_ADMIN_URL", "restart": False}))
elif step == "deploy-api":
    show("deploy-api", *call("POST", f"/api/v1/apps/{API}/deploy", {"wait": True, "timeout_seconds": 900}, timeout=960))
    latest(API)
elif step == "deploy-web":
    show("deploy-web", *call("POST", f"/api/v1/apps/{WEB}/deploy", {"wait": True, "timeout_seconds": 900}, timeout=960))
    latest(WEB)
elif step == "run":
    st, lines = run_logged(API, sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 120)
    print("status", st)
    print("\n".join(lines))
elif step == "unset":
    show("unset", *call("POST", f"/api/v1/apps/{API}/env/unset", {"keys": ["DATABASE_ADMIN_URL", "APP_ROLE_PASSWORD"]}))
elif step == "restart":
    show("restart", *call("POST", f"/api/v1/apps/{API}/lifecycle", {"action": "restart"}))
else:
    sys.exit(f"unknown step {step}: connect, deploy-api, deploy-web, run, unset, restart")
