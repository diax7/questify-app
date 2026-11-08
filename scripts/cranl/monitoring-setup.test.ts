import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// monitoring-setup.py talks to CranL with urllib; here CRANL_API_URL points at a local server that lists apps and
// records every request, so no test reaches CranL and a refusal can be shown to have made no write.
const SCRIPTS = import.meta.dirname;
const SETUP = join(SCRIPTS, "monitoring-setup.py");

let server: Server;
let base: string;
let dir: string;
let requests: { method: string; url: string }[];
let bodies: Record<string, any>[];
let apps: { name: string }[];

beforeEach(async () => {
  requests = [];
  bodies = [];
  apps = [];
  dir = mkdtempSync(join(tmpdir(), "monitoring-setup-"));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const method = req.method ?? "";
      const url = req.url ?? "";
      requests.push({ method, url });
      bodies.push(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(fakeCranl(method, url)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

/** The few CranL routes `create` uses, answered like CranL does: the app list, the new app, then empty acknowledgements. */
function fakeCranl(method: string, url: string): Record<string, unknown> {
  if (method === "GET" && url === "/api/v1/apps") return { apps };
  if (method === "POST" && url === "/api/v1/apps") {
    return { app: { id: "app-1", url: "https://monitoring-x1y.cranl.net/" } };
  }
  return { ok: true };
}

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** Runs python3 in the temp folder (the state file is relative to it) against the local server; never fails the call. */
function python(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "python3",
      ["-I", ...args],
      {
        cwd: dir,
        env: { PATH: process.env["PATH"], CRANL_API_KEY: "test-key", CRANL_API_URL: base },
      },
      (error, out, err) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, out, err });
      },
    );
  });
}

/** Loads monitoring-setup.py as a module and runs one Python expression on it (`m` is the module). */
const callSetup = (expression: string) =>
  python([
    "-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)}); import importlib.util as u
spec = u.spec_from_file_location("setup", ${JSON.stringify(SETUP)}); m = u.module_from_spec(spec)
spec.loader.exec_module(m); ${expression}`,
  ]);

const create = () => callSetup("m.cmd_create()");
// bcrypt_hash shells out to docker; the success path swaps it for a fixed fake so no container starts.
const createWithFakeHash = () =>
  callSetup('m.bcrypt_hash = lambda password: "hash-of-" + password; m.cmd_create()');

describe("monitoring-setup.py create (ADR-626)", () => {
  it("refuses when the state file exists, before it asks CranL anything", async () => {
    writeFileSync(join(dir, "monitoring_state.json"), "{}");
    const result = await create();
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("create refused: monitoring_state.json exists");
    expect(requests).toEqual([]);
  });

  it("refuses when an app of that name exists, and creates nothing", async () => {
    apps = [{ name: "somebody-else" }, { name: "questify-monitoring-staging" }];
    const result = await create();
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("an app named questify-monitoring-staging already exists");
    expect(requests).toEqual([{ method: "GET", url: "/api/v1/apps" }]);
  });

  it("creates the app, mounts the volume, sets the root URL, deploys, and keeps the state file owner-only", async () => {
    const result = await createWithFakeHash();
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(requests).toEqual([
      { method: "GET", url: "/api/v1/apps" },
      { method: "POST", url: "/api/v1/apps" },
      { method: "POST", url: "/api/v1/apps/app-1/volumes" },
      { method: "PATCH", url: "/api/v1/apps/app-1/env" },
      { method: "POST", url: "/api/v1/apps/app-1/deploy" },
    ]);

    const created = bodies[1]!;
    expect(created).toMatchObject({
      name: "questify-monitoring-staging",
      region: "riyadh-1",
      build_path: "/ops/monitoring/stack",
      port: 8080,
    });
    expect(created["env"].METRICS_PASSWORD_HASH).toBe("hash-of-" + created["env"].METRICS_PASSWORD);
    expect(created["env"].GF_SERVER_ROOT_URL).toBe("https://placeholder.invalid/grafana/");
    expect(bodies[2]).toEqual({
      type: "volume",
      mount_path: "/data",
      volume_name: "monitoring-data",
    });
    expect(bodies[3]).toEqual({
      variables: { GF_SERVER_ROOT_URL: "https://monitoring-x1y.cranl.net/grafana/" },
    });
    expect(bodies[4]).toEqual({ wait: true, timeout_seconds: 900 });

    const path = join(dir, "monitoring_state.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      id: "app-1",
      url: "https://monitoring-x1y.cranl.net",
      metrics_password: created["env"].METRICS_PASSWORD,
    });
    expect(result.out).not.toContain(created["env"].METRICS_PASSWORD);
  });

  it("writes the state file readable by its owner only, also over a looser existing file", async () => {
    const path = join(dir, "monitoring_state.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    const result = await callSetup('m.write_state({"id": "a"})');
    expect(result.err).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
