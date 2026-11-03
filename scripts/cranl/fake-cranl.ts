// An in-memory CranL for the infrastructure script's tests (T-017): the routes the script calls, enough to answer
// like CranL does. It records every write, so a test can prove that a refusal changed nothing.
type Json = Record<string, any>;

interface App {
  id: string;
  name: string;
  region: string;
  port: number;
  url: string;
  protected: boolean;
  project: { id: string };
  source: { type: string; branch: string; build_path: string };
  env: Map<string, string>;
  volumes: Json[];
  cron: Json[];
  domains: string[];
}

export interface FakeCranl {
  fetch: typeof fetch;
  writes: { method: string; path: string; body: Json }[];
  apps: App[];
  databases: Json[];
  projects: Json[];
  buckets: Json[];
  failNext: (status: number, times?: number) => void;
  maskEnv: () => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function fakeCranl(): FakeCranl {
  let next = 1;
  const id = (prefix: string) => `${prefix}-${next++}`;
  const state = {
    projects: [{ id: "project-nafes", name: "Nafes" }] as Json[],
    apps: [] as App[],
    databases: [] as Json[],
    buckets: [] as Json[],
    writes: [] as { method: string; path: string; body: Json }[],
  };
  let failures: { status: number; left: number } | undefined;
  let masked = false;

  const app = (appId: string) => {
    const found = state.apps.find((a) => a.id === appId);
    if (found === undefined) throw new Error(`no app ${appId}`);
    return found;
  };

  const createApp = (body: Json) => {
    const created: App = {
      id: id("app"),
      name: body.name,
      region: body.region,
      port: body.port,
      url: `https://${body.name}-x${next}y.cranl.net`,
      protected: false,
      project: { id: body.project_id },
      source: { type: "public_repo", branch: body.branch, build_path: body.build_path },
      env: new Map(Object.entries(body.env ?? {})),
      volumes: [],
      cron: [],
      domains: [],
    };
    state.apps.push(created);
    return json(201, { app: { ...created, env: undefined } });
  };

  const appRoutes = (method: string, parts: string[], body: Json): Response | undefined => {
    const [, appId, sub, subId] = parts;
    if (appId === undefined)
      return method === "GET"
        ? json(200, { apps: state.apps.map((a) => ({ ...a, env: undefined })) })
        : createApp(body);
    const target = app(appId);
    if (sub === undefined && method === "PATCH") target.port = body.port;
    if (sub === "env" && method === "GET") {
      return json(200, {
        version: "v",
        variables: [...target.env].map(([key, value]) => ({
          key,
          value: masked ? "****" : value,
          masked,
        })),
      });
    }
    if (sub === "env" && method === "PATCH")
      for (const [k, v] of Object.entries(body.variables)) target.env.set(k, v as string);
    if (sub === "volumes" && method === "GET") return json(200, { volumes: target.volumes });
    if (sub === "volumes" && method === "POST")
      target.volumes.push({
        id: id("vol"),
        type: body.type,
        mount_path: body.mount_path,
        volume_name: body.volume_name,
        file_path: null,
      });
    if (sub === "cron" && method === "GET") return json(200, { jobs: target.cron });
    if (sub === "cron" && method === "POST")
      target.cron.push({
        id: id("job"),
        name: body.name,
        cron: body.cron,
        command: body.command,
        timezone: body.timezone,
      });
    if (sub === "cron" && method === "DELETE")
      target.cron = target.cron.filter((j) => j.id !== subId);
    if (sub === "domains" && method === "GET")
      return json(200, { domains: target.domains.map((host) => ({ id: host, host })) });
    if (sub === "domains" && method === "POST") target.domains.push(body.host);
    return json(200, {});
  };

  const databaseRoutes = (method: string, parts: string[], body: Json): Response => {
    const [, dbId, sub] = parts;
    if (dbId === undefined && method === "GET") return json(200, { databases: state.databases });
    if (dbId === undefined) {
      const db = {
        id: id("db"),
        name: body.name,
        type: body.type,
        region: body.region,
        project: { id: body.project_id },
        backups: {
          enabled: true,
          frequency: "daily",
          hour: 1,
          minute: 5,
          timezone: "UTC",
          keep: 7,
        },
      };
      state.databases.push(db);
      return json(201, { database: db });
    }
    const db = state.databases.find((d) => d.id === dbId)!;
    if (sub === "backups") {
      if (method === "PATCH") Object.assign(db.backups, body);
      return json(200, db.backups);
    }
    const variable = body.variable ?? (db.type === "redis" ? "REDIS_URL" : "DATABASE_URL");
    app(body.app_id).env.set(variable, `${db.type}://admin:password@${db.name}:5432/db`);
    return json(200, {});
  };

  const route = (method: string, path: string, body: Json): Response => {
    const parts = path.split("?")[0]!.split("/").filter(Boolean);
    const [root] = parts;
    if (root === "projects" && method === "GET") return json(200, { projects: state.projects });
    if (root === "projects") {
      const project = { id: id("project"), name: body.name };
      state.projects.push(project);
      return json(201, { project });
    }
    if (root === "apps") return appRoutes(method, parts, body) ?? json(404, {});
    if (root === "databases") return databaseRoutes(method, parts, body);
    if (root === "buckets" && method === "GET") return json(200, { buckets: state.buckets });
    if (root === "buckets") {
      state.buckets.push({ id: id("bucket"), name: body.name });
      return json(201, {});
    }
    return json(404, { error: { code: "not_found" } });
  };

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (failures !== undefined && failures.left > 0) {
      failures.left -= 1;
      return json(failures.status, { error: { code: "busy", message: "secret-looking body" } });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    if (method !== "GET") state.writes.push({ method, path: url.pathname, body });
    return route(method, url.pathname.replace(/^\/api\/v1/, "") + url.search, body);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    get writes() {
      return state.writes;
    },
    get apps() {
      return state.apps;
    },
    get databases() {
      return state.databases;
    },
    get projects() {
      return state.projects;
    },
    get buckets() {
      return state.buckets;
    },
    failNext: (status, times = 1) => {
      failures = { status, left: times };
    },
    maskEnv: () => {
      masked = true;
    },
  };
}
