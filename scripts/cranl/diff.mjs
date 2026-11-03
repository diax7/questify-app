// Compares an environment file with what CranL has (T-017, ADR-650) and lists the changes, as plain data. Pure: no
// call, no clock, no randomness. Three sorts of change come out:
//   - api: `apply` makes it with the CranL API;
//   - manual: the API cannot make it (a public-repo app's build folder or branch, a region, a database's type) and a
//     person changes it in the CranL dashboard, as the RUNBOOK says;
//   - unmanaged: CranL has a setting the file does not declare. Nothing is ever deleted: add it to the file, or
//     remove it in the dashboard, so that no setting lives only there.
import { envKind, fillTemplate } from "./spec.mjs";

const BACKUP_FIELDS = ["enabled", "frequency", "hour", "minute", "timezone", "keep"];

const api = (change) => ({ sort: "api", ...change });
const manual = (change) => ({ sort: "manual", ...change });
const unmanaged = (change) => ({ sort: "unmanaged", ...change });

function wantedBackups(backups) {
  const fields = backups.frequency === "weekly" ? [...BACKUP_FIELDS, "weekday"] : BACKUP_FIELDS;
  return Object.fromEntries(
    fields.filter((f) => backups[f] !== undefined).map((f) => [f, backups[f]]),
  );
}

function diffDatabase(spec, key, db, have) {
  if (have === null) {
    const changes = [api({ op: "database.create", db: key })];
    if (db.backups !== undefined)
      changes.push(api({ op: "database.backups", db: key, to: wantedBackups(db.backups) }));
    return changes;
  }
  const changes = [];
  if (have.type !== db.type)
    changes.push(
      manual({ op: "database.manual", db: key, field: "type", from: have.type, to: db.type }),
    );
  const region = db.region ?? spec.region;
  if (have.region !== region)
    changes.push(
      manual({ op: "database.manual", db: key, field: "region", from: have.region, to: region }),
    );
  if (db.backups !== undefined) {
    const to = wantedBackups(db.backups);
    const from = Object.fromEntries(Object.keys(to).map((f) => [f, have.backups?.[f]]));
    if (Object.keys(to).some((f) => from[f] !== to[f]))
      changes.push(api({ op: "database.backups", db: key, from, to }));
  }
  return changes;
}

function diffEnvValue(key, name, value, current, urls) {
  const kind = envKind(value);
  if (kind === "database") {
    return current === undefined
      ? [api({ op: "env.connect", app: key, name, db: value.database })]
      : [];
  }
  if (kind === "generate" || kind === "operator") {
    return current === undefined ? [api({ op: "env.set", app: key, name, kind })] : [];
  }
  const to = kind === "plain" ? value : fillTemplate(value.template, urls);
  if (current === to && to !== undefined) return [];
  return [
    api({
      op: "env.set",
      app: key,
      name,
      kind,
      to,
      ...(current === undefined ? {} : { from: current }),
    }),
  ];
}

function diffEnv(key, app, have, urls) {
  const current = have?.env ?? new Map();
  const changes = Object.entries(app.env).flatMap(([name, value]) =>
    diffEnvValue(key, name, value, current.get(name), urls),
  );
  for (const name of current.keys()) {
    if (app.env[name] === undefined)
      changes.push(unmanaged({ op: "env.unmanaged", app: key, name }));
  }
  return changes;
}

const volumeId = (v) => `${v.type}:${v.mount_path}:${v.volume_name ?? ""}`;
const sameJob = (a, b) =>
  a.schedule === b.schedule &&
  a.command === b.command &&
  (a.timezone ?? "UTC") === (b.timezone ?? "UTC");

function diffVolumes(key, app, have) {
  const changes = [];
  const volumes = new Set((have?.volumes ?? []).map(volumeId));
  for (const volume of app.volumes)
    if (!volumes.has(volumeId(volume))) changes.push(api({ op: "volume.add", app: key, volume }));
  const declaredVolumes = new Set(app.volumes.map(volumeId));
  for (const volume of have?.volumes ?? []) {
    if (!declaredVolumes.has(volumeId(volume)))
      changes.push(unmanaged({ op: "volume.unmanaged", app: key, volume }));
  }
  return changes;
}

function diffCron(key, app, have) {
  const changes = [];
  for (const job of app.cron) {
    const live = have?.cron.find((j) => j.name === job.name);
    if (live === undefined) changes.push(api({ op: "cron.add", app: key, job }));
    else if (!sameJob(live, job))
      changes.push(manual({ op: "cron.manual", app: key, job: job.name }));
  }
  for (const job of have?.cron ?? []) {
    if (!app.cron.some((j) => j.name === job.name))
      changes.push(unmanaged({ op: "cron.unmanaged", app: key, job: job.name }));
  }
  return changes;
}

function diffDomains(key, app, have) {
  const live = have?.domains ?? [];
  return [
    ...app.domains
      .filter((host) => !live.includes(host))
      .map((host) => api({ op: "domain.add", app: key, host })),
    ...live
      .filter((host) => !app.domains.includes(host))
      .map((host) => unmanaged({ op: "domain.unmanaged", app: key, host })),
  ];
}

function diffSource(spec, key, app, have) {
  const wanted = {
    region: app.region ?? spec.region,
    branch: app.branch ?? spec.branch,
    buildPath: app.build_path,
  };
  const changes = [];
  for (const [field, to] of Object.entries(wanted)) {
    if (have[field] !== to)
      changes.push(manual({ op: "app.manual", app: key, field, from: have[field], to }));
  }
  if (have.protected)
    changes.push(manual({ op: "app.manual", app: key, field: "protected", from: true, to: false }));
  if (have.port !== app.port)
    changes.push(api({ op: "app.port", app: key, from: have.port, to: app.port }));
  return changes;
}

/**
 * The changes that make CranL match the file, in the order `apply` makes them.
 *
 * @param {any} spec A checked environment file.
 * @param {any} state What `observe` read.
 */
export function diff(spec, state) {
  const changes = state.project === null ? [api({ op: "project.create" })] : [];
  for (const [key, db] of Object.entries(spec.databases))
    changes.push(...diffDatabase(spec, key, db, state.databases[key]));
  for (const bucket of spec.buckets)
    if (!state.buckets.has(bucket)) changes.push(api({ op: "bucket.create", bucket }));
  const urls = Object.fromEntries(
    Object.entries(state.apps).map(([key, have]) => [key, have?.url]),
  );
  for (const [key, app] of Object.entries(spec.apps)) {
    const have = state.apps[key];
    if (have === null) changes.push(api({ op: "app.create", app: key }));
    else changes.push(...diffSource(spec, key, app, have));
    changes.push(
      ...diffEnv(key, app, have, urls),
      ...diffVolumes(key, app, have),
      ...diffCron(key, app, have),
      ...diffDomains(key, app, have),
    );
  }
  return changes;
}
