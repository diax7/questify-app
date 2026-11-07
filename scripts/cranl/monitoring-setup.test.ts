import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
let apps: { name: string }[];

beforeEach(async () => {
  requests = [];
  apps = [];
  dir = mkdtempSync(join(tmpdir(), "monitoring-setup-"));
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ apps }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

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

  it("writes the state file readable by its owner only, also over a looser existing file", async () => {
    const path = join(dir, "monitoring_state.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    const result = await callSetup('m.write_state({"id": "a"})');
    expect(result.err).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
