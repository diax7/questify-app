import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apply, describe as describeChange } from "./apply.mjs";
import { createClient } from "./client.mjs";
import { diff } from "./diff.mjs";
import { fakeCranl } from "./fake-cranl";
import { main } from "./infra.mjs";
import { observe } from "./observe.mjs";
import { checkSpec, fillTemplate, loadSpec } from "./spec.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const OPERATOR = {
  SECRET_API_GMAIL_SERVICE_ACCOUNT_KEY: "operator-gmail-key",
  SECRET_API_MSEGAT_USERNAME: "operator-msegat-user",
  SECRET_API_MSEGAT_API_KEY: "operator-msegat-key",
  SECRET_MONITORING_METRICS_PASSWORD: "operator-metrics-password",
  SECRET_MONITORING_METRICS_PASSWORD_HASH: "operator-metrics-hash",
};

const staging = () => loadSpec(join(ROOT, "ops", "cranl", "staging.json"));
const clientFor = (cranl: ReturnType<typeof fakeCranl>) =>
  createClient({ apiKey: "test-key", fetch: cranl.fetch, retryDelayMs: 0 });

async function planOf(cranl: ReturnType<typeof fakeCranl>, spec = staging()) {
  return diff(spec, await observe(clientFor(cranl), spec));
}

async function applied(spec = staging()) {
  const cranl = fakeCranl();
  const log: string[] = [];
  let n = 0;
  const result = await apply({
    client: clientFor(cranl),
    spec,
    env: OPERATOR,
    generate: () => `generated-secret-${++n}`,
    runId: "run1",
    log: (line: string) => log.push(line),
  });
  return { cranl, log, result };
}

describe("apply on an empty account", () => {
  it("creates every declared resource, and a second plan finds nothing to change", async () => {
    const { cranl, result } = await applied();
    expect(cranl.apps.map((a) => a.name).toSorted()).toEqual([
      "questify-api-staging",
      "questify-prometheus-staging",
      "questify-web-staging",
    ]);
    expect(cranl.databases.map((d) => `${d.name}:${d.type}:${d.region}`)).toEqual([
      "questify-db:postgresql:riyadh-1",
      "questify-cache:redis:riyadh-1",
    ]);
    expect(result.rest).toEqual([]);
    expect(await planOf(cranl)).toEqual([]);
  });

  it("is idempotent: a second apply makes no write", async () => {
    const { cranl } = await applied();
    const writes = cranl.writes.length;
    const again = await apply({
      client: clientFor(cranl),
      spec: staging(),
      env: OPERATOR,
      runId: "run2",
    });
    expect(again.done).toBe(0);
    expect(cranl.writes.length).toBe(writes);
  });

  it("fills templates from the new apps' addresses and connects the databases", async () => {
    const { cranl } = await applied();
    const api = cranl.apps.find((a) => a.name === "questify-api-staging")!;
    const web = cranl.apps.find((a) => a.name === "questify-web-staging")!;
    const monitoring = cranl.apps.find((a) => a.name === "questify-prometheus-staging")!;
    expect(web.env.get("API_ORIGIN")).toBe(
      `http://${new URL(api.url).hostname.split(".")[0]}:3000`,
    );
    expect(monitoring.env.get("GF_SERVER_ROOT_URL")).toBe(`${monitoring.url}/grafana/`);
    expect(api.env.get("DATABASE_URL")).toMatch(/^postgresql:\/\//);
    expect(api.env.get("REDIS_URL")).toMatch(/^redis:\/\//);
    expect(monitoring.volumes).toEqual([
      expect.objectContaining({
        type: "volume",
        mount_path: "/data",
        volume_name: "monitoring-data",
      }),
    ]);
    expect(web.domains).toEqual(["questify.nafes.com"]);
  });

  it("sets generated and operator secrets, and never logs a secret value", async () => {
    const { cranl, log } = await applied();
    const api = cranl.apps.find((a) => a.name === "questify-api-staging")!;
    expect(api.env.get("AUTH_SECRET")).toMatch(/^generated-secret-\d+$/);
    expect(api.env.get("MSEGAT_API_KEY")).toBe("operator-msegat-key");
    const text = log.join("\n");
    for (const value of [...Object.values(OPERATOR), "generated-secret", "password@"]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("env.set api AUTH_SECRET (generate secret)");
  });

  it("sets the declared backup schedule of the database", async () => {
    const { cranl } = await applied();
    expect(cranl.databases[0]!.backups).toMatchObject({
      frequency: "daily",
      hour: 0,
      minute: 28,
      keep: 7,
    });
  });

  it("refuses before any write when an operator secret is missing", async () => {
    const cranl = fakeCranl();
    const env = { ...OPERATOR, SECRET_API_MSEGAT_API_KEY: undefined };
    await expect(apply({ client: clientFor(cranl), spec: staging(), env })).rejects.toThrow(
      /nothing was changed\): SECRET_API_MSEGAT_API_KEY$/,
    );
    expect(cranl.writes).toEqual([]);
  });

  it("creates a missing project and buckets", async () => {
    const spec = { ...staging(), project: "Questify", buckets: ["questify-media"] };
    const { cranl } = await applied(spec);
    expect(cranl.projects.map((p) => p.name)).toContain("Questify");
    expect(cranl.buckets.map((b) => b.name)).toEqual(["questify-media"]);
    expect(cranl.apps.every((a) => a.project.id === cranl.projects.at(-1)!.id)).toBe(true);
  });
});

describe("plan on an existing environment", () => {
  it("leaves a secret that exists alone, and never reads its value into the state", async () => {
    const { cranl } = await applied();
    const state = await observe(clientFor(cranl), staging());
    expect(state.apps.api.env.get("AUTH_SECRET")).toBe(true);
    expect(state.apps.api.env.get("DATABASE_URL")).toBe(true);
    expect(state.apps.api.env.get("NODE_ENV")).toBe("production");
  });

  it("shows a changed plain value with its old and new value, and apply restores it", async () => {
    const { cranl } = await applied();
    cranl.apps.find((a) => a.name === "questify-api-staging")!.env.set("TRUST_PROXY_HOPS", "2");
    const changes = await planOf(cranl);
    expect(changes.map(describeChange)).toEqual([
      'api       env.set api TRUST_PROXY_HOPS differs -> "1"',
    ]);
    await apply({ client: clientFor(cranl), spec: staging(), env: OPERATOR, runId: "run2" });
    expect(await planOf(cranl)).toEqual([]);
  });

  it("reports settings the file does not declare, and apply deletes none of them", async () => {
    const { cranl } = await applied();
    const web = cranl.apps.find((a) => a.name === "questify-web-staging")!;
    web.env.set("DASHBOARD_ONLY", "x");
    web.domains.push("old.example.com");
    web.volumes.push({ id: "v9", type: "volume", mount_path: "/tmp", volume_name: "t" });
    web.cron.push({ id: "j9", name: "hand-made", cron: "* * * * *", command: "true" });
    const changes = await planOf(cranl);
    expect(changes.map((c: any) => `${c.sort} ${c.op}`)).toEqual([
      "unmanaged env.unmanaged",
      "unmanaged volume.unmanaged",
      "unmanaged cron.unmanaged",
      "unmanaged domain.unmanaged",
    ]);
    const result = await apply({
      client: clientFor(cranl),
      spec: staging(),
      env: OPERATOR,
      runId: "run2",
    });
    expect(result.rest).toHaveLength(4);
    expect(web.env.get("DASHBOARD_ONLY")).toBe("x");
    expect(web.cron).toHaveLength(1);
  });

  it("names a build folder, branch or region the API cannot change as a manual step", async () => {
    const { cranl } = await applied();
    const monitoring = cranl.apps.find((a) => a.name === "questify-prometheus-staging")!;
    monitoring.source.build_path = "/ops/monitoring/prometheus";
    monitoring.region = "germany-1";
    monitoring.protected = true;
    const changes = await planOf(cranl);
    expect(changes.map(describeChange)).toEqual([
      'manual    app.manual monitoring region "germany-1" -> "riyadh-1"',
      'manual    app.manual monitoring buildPath "/ops/monitoring/prometheus" -> "/ops/monitoring/stack"',
      "manual    app.manual monitoring protected true -> false",
    ]);
    const writes = cranl.writes.length;
    const result = await apply({
      client: clientFor(cranl),
      spec: staging(),
      env: OPERATOR,
      runId: "run2",
    });
    expect(result.rest).toHaveLength(3);
    expect(cranl.writes.length).toBe(writes);
  });

  it("changes a port, fixes backups and leaves a changed cron job to the operator", async () => {
    const spec = staging();
    spec.apps.api.cron = [
      { name: "nightly", schedule: "0 3 * * *", command: "node x.js", timezone: "Asia/Riyadh" },
    ];
    const { cranl } = await applied(spec);
    const api = cranl.apps.find((a) => a.name === "questify-api-staging")!;
    api.port = 4000;
    api.cron[0]!.cron = "0 4 * * *";
    cranl.databases[0]!.backups.keep = 3;
    const ops = (await planOf(cranl, spec)).map((c: any) => c.op);
    expect(ops).toEqual(["database.backups", "app.port", "cron.manual"]);
    const result = await apply({ client: clientFor(cranl), spec, env: OPERATOR, runId: "run2" });
    expect(api.port).toBe(3000);
    expect(cranl.writes.some((w: any) => w.method === "DELETE")).toBe(false);
    expect(api.cron).toEqual([expect.objectContaining({ name: "nightly", cron: "0 4 * * *" })]);
    expect(result.rest.map((c: any) => c.op)).toEqual(["cron.manual"]);
  });
});

describe("the CranL client", () => {
  it("retries a read that CranL answers with 503", async () => {
    const cranl = fakeCranl();
    cranl.failNext(503, 2);
    await expect(clientFor(cranl).get("/projects")).resolves.toEqual({
      projects: [expect.anything()],
    });
  });

  it("fails with the method, path and code, never the body, once retries run out", async () => {
    const cranl = fakeCranl();
    cranl.failNext(503, 3);
    const error = await clientFor(cranl)
      .get("/apps")
      .catch((e: Error) => e);
    expect(error.message).toBe("CranL GET /apps failed: 503 busy");
    expect(error.message).not.toContain("secret-looking");
  });

  it("does not retry a refusal", async () => {
    const cranl = fakeCranl();
    cranl.failNext(400, 1);
    await expect(clientFor(cranl).send("POST", "/buckets", { name: "x" }, "k")).rejects.toThrow(
      "400",
    );
    expect(cranl.buckets).toEqual([]);
  });

  it("fails on a success answer that is not JSON", async () => {
    const client = createClient({
      apiKey: "k",
      fetch: (async () => new Response("<html>", { status: 200 })) as typeof fetch,
      retryDelayMs: 0,
    });
    await expect(client.get("/apps")).rejects.toThrow("CranL GET /apps answered 200 without JSON");
  });

  it("refuses masked values instead of planning endless drift", async () => {
    const { cranl } = await applied(staging());
    cranl.maskEnv();
    await expect(planOf(cranl, staging())).rejects.toThrow("needs the env:reveal scope");
  });

  it("sends the idempotency key with every write", async () => {
    const cranl = fakeCranl();
    await clientFor(cranl).send("POST", "/buckets", { name: "x" }, "key-1");
    expect(cranl.writes[0]!.body).toEqual({ name: "x", idempotency_key: "key-1" });
  });
});

const base = () => JSON.parse(readFileSync(join(ROOT, "ops", "cranl", "staging.json"), "utf8"));

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "cranl-infra-"));
  mkdirSync(join(root, "ops", "cranl"), { recursive: true });
  writeFileSync(
    join(root, "ops", "cranl", "staging.json"),
    readFileSync(join(ROOT, "ops", "cranl", "staging.json")),
  );
  return root;
}

describe("the environment files", () => {
  it("staging and production both pass the checks", () => {
    expect(() => staging()).not.toThrow();
    expect(() => loadSpec(join(ROOT, "ops", "cranl", "production.json"))).not.toThrow();
  });

  it("keeps Questify to three apps and two databases per environment (ADR-626)", () => {
    for (const name of ["staging", "production"]) {
      const spec = loadSpec(join(ROOT, "ops", "cranl", `${name}.json`));
      expect(Object.keys(spec.apps).toSorted()).toEqual(["api", "monitoring", "web"]);
      expect(
        Object.values(spec.databases)
          .map((d: any) => d.type)
          .toSorted(),
      ).toEqual(["postgresql", "redis"]);
    }
  });

  it("holds no secret value: every secret-looking name says where its value comes from", () => {
    for (const name of ["staging", "production"]) {
      const spec = loadSpec(join(ROOT, "ops", "cranl", `${name}.json`));
      for (const app of Object.values(spec.apps) as any[]) {
        for (const [key, value] of Object.entries(app.env)) {
          if (/SECRET|PASSWORD|KEY|USERNAME|HEADERS|_URL$/.test(key))
            expect(typeof value, key).toBe("object");
        }
      }
    }
  });

  it.each([
    [(s: any) => (s.git_url = "https://github.com/diax7/questify-app"), /\.git URL/],
    [(s: any) => (s.apps.api.env.DATABASE_URL = { database: "nope" }), /no database "nope"/],
    [
      (s: any) => (s.apps.web.env.API_ORIGIN = { template: "http://{nope.host}" }),
      /undeclared app "nope"/,
    ],
    [
      (s: any) => (s.databases.redis.backups = { frequency: "daily", keep: 7 }),
      /does not back up Redis/,
    ],
    [(s: any) => (s.apps.api.env.X = { secret: "maybe" }), /apps\.api\.env\.X/],
    [(s: any) => (s.apps.api.build_path = "ops"), /build_path/],
    [(s: any) => delete s.apps.api.cron, /apps\.api\.cron/],
    [(s: any) => (s.databases.postgres.backups.keep = 31), /keep 1 to 30/],
  ])("refuses a broken file (%#)", (breakIt, message) => {
    const spec = base();
    breakIt(spec);
    expect(() => checkSpec(spec, "staging.json")).toThrow(message);
  });

  it("fills a template only once every app it names has an address", () => {
    expect(
      fillTemplate("{a.url}/x and {b.host}", {
        a: "https://a-1.cranl.net",
        b: "https://b-2.cranl.net",
      }),
    ).toBe("https://a-1.cranl.net/x and b-2");
    expect(fillTemplate("{a.url}", {})).toBeUndefined();
  });
});

describe("the command", () => {
  it("plan exits 2 with changes and 0 once CranL matches; apply exits 0", async () => {
    const cranl = fakeCranl();
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const options = {
      env: { ...OPERATOR, CRANL_API_KEY: "k" },
      fetch: cranl.fetch,
      root: tempRoot(),
      print,
    };
    expect(await main(["plan", "staging"], options)).toBe(2);
    expect(cranl.writes).toEqual([]);
    expect(await main(["apply", "staging"], options)).toBe(0);
    expect(await main(["plan", "staging"], options)).toBe(0);
    expect(lines.at(-1)).toBe("No changes: CranL matches the file.");
  });

  it("prints the usage and exits 1 for an unknown command or environment name", async () => {
    expect(
      await main(["destroy", "staging"], { env: { CRANL_API_KEY: "k" }, print: () => {} }),
    ).toBe(1);
    expect(
      await main(["plan", "../staging"], { env: { CRANL_API_KEY: "k" }, print: () => {} }),
    ).toBe(1);
  });
});
