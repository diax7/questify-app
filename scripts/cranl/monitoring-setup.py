"""Creates Questify's one staging monitoring app on CranL (ADR-626, RUNBOOK "Monitoring stack on CranL").

Secrets are generated here and written only into CranL app settings; nothing secret is printed or kept after "api".
Usage: python monitoring_setup.py create | api
"""
import base64
import json
import os
import secrets
import subprocess
import sys

from cranl_api import call

REPO = "https://github.com/diax7/questify-app.git"
REGION = "riyadh-1"
PROJECT = "612b057e-ad2c-412c-afce-f0fa12c5de08"
API = "7fc67d79-a5e5-4ecf-b366-dd7e9eeabd70"
NAME = "questify-monitoring-staging"
STATE = "monitoring_state.json"


def token(n=32):
    return base64.urlsafe_b64encode(secrets.token_bytes(n)).decode().rstrip("=")


def bcrypt_hash(password):
    out = subprocess.run(
        ["docker", "run", "--rm",
         "httpd:2.4.69-alpine@sha256:070da7661f0be8a05430b2c125c0cde9e53176b4048c813024021969a0e3893c",
         "htpasswd", "-nbBC", "10", "questify-metrics", password],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return out.split(":", 1)[1]


def write_state(state):
    """Writes the state file readable by its owner only; it holds the metrics password until "api" removes it."""
    fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)


def refuse_second_create():
    """A second create makes a second app, so stop when a state file or an app of this name already exists."""
    if os.path.exists(STATE):
        sys.exit(f"create refused: {STATE} exists (a first create ran). Run 'api' or remove the file on purpose.")
    s, r = call("GET", "/api/v1/apps")
    if s >= 300:
        fail("list apps", s, r)
    if any(a.get("name") == NAME for a in r.get("apps", [])):
        sys.exit(f"create refused: an app named {NAME} already exists.")


def fail(tag, status, body):
    err = body.get("error", {}) if isinstance(body, dict) else {}
    print(tag, status, err.get("code"), err.get("field"), str(err.get("message"))[:200])
    sys.exit(1)


def cmd_create():
    refuse_second_create()
    metrics_password = token()
    s, r = call("POST", "/api/v1/apps", {
        "name": NAME, "region": REGION, "git_url": REPO, "branch": "main", "project_id": PROJECT,
        "build": "dockerfile", "build_path": "/ops/monitoring/stack", "dockerfile_path": "Dockerfile",
        "port": 8080, "wait": False, "description": "Questify monitoring (staging, ADR-626)",
        "env": {
            "METRICS_PASSWORD": metrics_password,
            "METRICS_PASSWORD_HASH": bcrypt_hash(metrics_password),
            "GF_SECURITY_ADMIN_PASSWORD": token(),
            "GF_SECURITY_SECRET_KEY": token(40),
            "GF_SERVER_ROOT_URL": "https://placeholder.invalid/grafana/",
        },
    }, timeout=120)
    if s >= 300:
        fail("create", s, r)
    app = r.get("app", r)
    app_id, url = app["id"], app["url"].rstrip("/")
    write_state({"id": app_id, "url": url, "metrics_password": metrics_password})
    print("created", app_id, url)
    s, r = call("POST", f"/api/v1/apps/{app_id}/volumes",
                {"type": "volume", "mount_path": "/data", "volume_name": "monitoring-data"})
    print("volume", s, json.dumps(r)[:160])
    s, r = call("PATCH", f"/api/v1/apps/{app_id}/env", {"variables": {"GF_SERVER_ROOT_URL": url + "/grafana/"}})
    print("root url", s)
    s, r = call("POST", f"/api/v1/apps/{app_id}/deploy", {"wait": True, "timeout_seconds": 900}, timeout=960)
    print("deploy", s, json.dumps(r)[:200])


def cmd_api():
    state = json.load(open(STATE))
    basic = base64.b64encode(f"questify-metrics:{state['metrics_password']}".encode()).decode()
    s, r = call("PATCH", f"/api/v1/apps/{API}/env", {"variables": {
        "TELEMETRY_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_ENDPOINT": state["url"] + "/api/v1/otlp",
        "OTEL_EXPORTER_OTLP_HEADERS": "authorization=Basic%20" + basic,
        "TELEMETRY_TRACE_RATIO": "0",
    }})
    print("api env", s)
    del state["metrics_password"]
    write_state(state)


if __name__ == "__main__":
    {"create": cmd_create, "api": cmd_api}[sys.argv[1]]()
