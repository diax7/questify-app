// Reads what exists on CranL for one environment file, with GET calls only (T-017, ADR-650). Variable values are read
// revealed but kept only for the names the file declares as plain or template values; every other value is replaced
// by `true` (present) at once, so a secret never leaves this function.
import { envKind } from "./spec.mjs";

const trimUrl = (url) => (typeof url === "string" ? url.replace(/\/+$/, "") : undefined);

function normaliseJob(job) {
  return {
    name: job.name,
    schedule: job.cron ?? job.schedule,
    command: job.command,
    timezone: job.timezone ?? "UTC",
  };
}

async function observeEnv(client, id, declared) {
  const { variables } = await client.get(`/apps/${id}/env?reveal=true`);
  const env = new Map();
  for (const variable of variables) {
    const kind = envKind(declared[variable.key]);
    env.set(variable.key, kind === "plain" || kind === "template" ? variable.value : true);
  }
  return env;
}

async function observeApp(client, summary, declared) {
  const id = summary.id;
  const [env, volumes, cron, domains] = await Promise.all([
    observeEnv(client, id, declared.env),
    client.get(`/apps/${id}/volumes`),
    client.get(`/apps/${id}/cron`),
    client.get(`/apps/${id}/domains`),
  ]);
  return {
    id,
    region: summary.region,
    port: summary.port,
    url: trimUrl(summary.url),
    sourceType: summary.source?.type,
    branch: summary.source?.branch,
    buildPath: summary.source?.build_path,
    protected: summary.protected === true,
    env,
    volumes: volumes.volumes.map((v) => ({
      id: v.id,
      type: v.type,
      mount_path: v.mount_path,
      volume_name: v.volume_name,
    })),
    cron: cron.jobs.map((job) => ({ id: job.id, ...normaliseJob(job) })),
    domains: domains.domains.map((domain) => domain.host),
  };
}

async function observeDatabase(client, summary, declared) {
  const database = {
    id: summary.id,
    type: summary.type,
    region: summary.region,
    backups: undefined,
  };
  if (declared.backups !== undefined) {
    database.backups = await client.get(`/databases/${summary.id}/backups/policy`);
  }
  return database;
}

const byName = (list, projectId, name) =>
  list.find(
    (item) => item.name === name && (projectId === undefined || item.project?.id === projectId),
  );

/**
 * The live state of everything the file declares; an entry is null when CranL has no such resource.
 *
 * @param {{ get: (path: string) => Promise<any> }} client
 * @param {any} spec A checked environment file.
 */
export async function observe(client, spec) {
  const [{ projects }, { apps }, { databases }, { buckets }] = await Promise.all([
    client.get("/projects"),
    client.get("/apps"),
    client.get("/databases"),
    client.get("/buckets"),
  ]);
  const project = projects.find((p) => p.name === spec.project) ?? null;
  const projectId = project?.id;
  const state = { project, apps: {}, databases: {}, buckets: new Set(buckets.map((b) => b.name)) };
  for (const [key, db] of Object.entries(spec.databases)) {
    const summary = project && byName(databases, projectId, db.name);
    state.databases[key] = summary ? await observeDatabase(client, summary, db) : null;
  }
  for (const [key, app] of Object.entries(spec.apps)) {
    const summary = project && byName(apps, projectId, app.name);
    state.apps[key] = summary ? await observeApp(client, summary, app) : null;
  }
  return state;
}
