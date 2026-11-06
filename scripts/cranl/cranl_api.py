"""A small CranL API client for scripts/cranl/deploy-staging.py and monitoring-setup.py. Never prints the key."""
import json, os, urllib.request, urllib.error

def _key():
    if os.environ.get("CRANL_API_KEY"):
        return os.environ["CRANL_API_KEY"]
    with open(os.path.expanduser("~/.cranl/config.json"), encoding="utf-8") as f:
        return json.load(f)["api_key"]

KEY = _key()
BASE = os.environ.get("CRANL_API_URL", "https://app.cranl.com")

def call(method,path,body=None,timeout=900):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(BASE+path,data=data,method=method,headers={"Authorization":"Bearer "+KEY,"Accept":"application/json","Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            txt=r.read().decode(); return r.status,(json.loads(txt) if txt else {})
    except urllib.error.HTTPError as e:
        txt=e.read().decode()
        try: return e.code,json.loads(txt)
        except Exception: return e.code,{"raw":txt[:500]}
SECRET=("pass","secret","connection","token","key","uri","dsn")
def clean(o):
    if isinstance(o,dict): return {k:("<hidden>" if any(s in k.lower() for s in SECRET) and k not in ("idempotency_key",) else clean(v)) for k,v in o.items()}
    if isinstance(o,list): return [clean(x) for x in o]
    return o

def run(app, command, timeout=120):
    s, r = call("POST", f"/api/v1/apps/{app}/run", {"command": command, "timeout_seconds": timeout}, timeout=timeout + 30)
    return s, r

def run_logged(app, command, timeout=120, lines=12):
    """Run a command and show its output through the app log, because the run endpoint returns no output."""
    import time
    marker = "RUNOUT-" + str(int(time.time()))
    cmd = "( echo %s-start; %s; echo %s-exit-$? ) > /proc/1/fd/1 2>&1" % (marker, command, marker)
    s, r = call("POST", f"/api/v1/apps/{app}/run", {"command": cmd, "shell": "sh", "timeout_seconds": timeout}, timeout=timeout + 30)
    time.sleep(3)
    s2, logs = call("GET", f"/api/v1/apps/{app}/logs?tail=200")
    out = [l["text"] for l in logs.get("lines", [])]
    keep = []
    on = False
    for t in out:
        if marker + "-start" in t: on = True; continue
        if marker + "-exit" in t: keep.append(t); break
        if on: keep.append(t)
    return r.get("status"), keep
