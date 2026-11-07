// Makes CranL match an environment file (T-017, ADR-650). Two rounds: first the resources that are missing (project,
// databases, buckets, apps), then, from a fresh read, everything inside them (variables, database connections,
// volumes, cron jobs, domains, ports), because a template needs the new apps' addresses. A last read must show no API
// change left, or apply fails: that is the "a second run changes nothing" check, made on every run. Nothing is ever
// deleted (only a cron job that changed is replaced). Secret values are sent to CranL and never returned or printed.
import { createHash, randomBytes } from "node:crypto";

import { diff } from "./diff.mjs";
import { observe } from "./observe.mjs";
import { operatorVariable } from "./spec.mjs";

const CREATES = new Set(["project.create", "database.create", "bucket.create", "app.create"]);

/** What Questify may hold on CranL for one environment: three apps and two databases (ADR-626, Q-613). */
export const BUDGET = { apps: 3, databases: 2 };

/**
 * Refuses, before any write, a file that declares more apps or databases than the budget, and a create that would take
 * the project past it. A project already over the budget (staging holds a fourth app until Dhia deletes the old
 * monitoring app, ADR-812) is not an error while nothing of that kind is created.
 */
export function checkBudget(spec, state, creates) {
  const problems = [];
  for (const [kind, limit] of Object.entries(BUDGET)) {
    const declared = Object.keys(spec[kind]).length;
    const creating = creates.filter((c) => c.op === `${kind.slice(0, -1)}.create`).length;
    if (declared > limit)
      problems.push(`the file declares ${declared} ${kind}, the budget is ${limit}`);
    else if (creating > 0 && state.live[kind] + creating > limit) {
      problems.push(
        `${kind}: ${state.live[kind]} exist and ${creating} would be created, the budget is ${limit}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Over the apps and databases budget (nothing was changed): ${problems.join("; ")}`,
    );
  }
}

export const generateSecret = () => randomBytes(32).toString("base64url");

/** Describes a change in one line; a secret's value is never part of a change. */
export function describe(change) {
  const what =
    change.name ??
    change.field ??
    change.host ??
    change.volume?.mount_path ??
    change.job?.name ??
    change.job;
  const where = [change.app ?? change.db ?? change.bucket, what].filter(Boolean).join(" ");
  return `${change.sort.padEnd(9)} ${change.op} ${where}${detailOf(change)}`.trimEnd();
}

function detailOf(change) {
  if (change.kind !== undefined && change.kind !== "plain" && change.kind !== "template") {
    return ` (${change.kind} secret)`;
  }
  if (change.to === undefined && change.kind === undefined) return "";
  const to = change.to === undefined ? "(once the app it names exists)" : JSON.stringify(change.to);
  if (change.from === undefined) return ` = ${to}`;
  // A live variable's value may hold a secret on CranL, so plan never prints it.
  return change.op === "env.set" ? ` differs -> ${to}` : ` ${JSON.stringify(change.from)} -> ${to}`;
}

/** The operator variables a change list needs that the environment does not carry. */
export function missingOperatorSecrets(changes, env) {
  return changes
    .filter((c) => c.op === "env.set" && c.kind === "operator")
    .map((c) => operatorVariable(c.app, c.name))
    .filter((variable) => !env[variable]);
}

function keyMaker(spec, runId) {
  return (change) =>
    `questify-${spec.environment}-${runId}-` +
    createHash("sha256").update(JSON.stringify(change)).digest("hex").slice(0, 32);
}

const idOf = (body) =>
  body?.app?.id ?? body?.database?.id ?? body?.project?.id ?? body?.bucket?.id ?? body?.id;

async function create(ctx, change) {
  const { client, spec, state, key } = ctx;
  if (change.op === "project.create") {
    state.project = {
      id: idOf(await client.send("POST", "/projects", { name: spec.project }, key(change))),
    };
    return;
  }
  const project_id = state.project.id;
  if (change.op === "database.create") {
    const db = spec.databases[change.db];
    const body = { name: db.name, type: db.type, region: db.region ?? spec.region, project_id };
    await client.send("POST", "/databases", body, key(change));
  } else if (change.op === "bucket.create") {
    await client.send("POST", "/buckets", { name: change.bucket, project_id }, key(change));
  } else {
    const app = spec.apps[change.app];
    const body = {
      name: app.name,
      region: app.region ?? spec.region,
      git_url: spec.git_url,
      branch: app.branch ?? spec.branch,
      build: "dockerfile",
      dockerfile_path: app.dockerfile_path,
      build_path: app.build_path,
      port: app.port,
      kind: "web",
      project_id,
      description: app.description ?? `Questify ${change.app} (${spec.environment})`,
      wait: false,
    };
    await client.send("POST", "/apps", body, key(change));
  }
}

function secretValue(ctx, change) {
  if (change.kind === "generate")
    return ctx.env[operatorVariable(change.app, change.name)] || ctx.generate();
  return ctx.env[operatorVariable(change.app, change.name)];
}

async function setVariables(ctx, appKey, changes) {
  const variables = {};
  for (const change of changes) {
    variables[change.name] =
      change.kind === "plain" || change.kind === "template" ? change.to : secretValue(ctx, change);
  }
  const names = changes.map(({ name, kind, to }) => ({
    name,
    kind,
    to: kind === "plain" || kind === "template" ? to : null,
  }));
  const id = ctx.state.apps[appKey].id;
  await ctx.client.send(
    "PATCH",
    `/apps/${id}/env`,
    { variables, restart: false },
    ctx.key({ op: "env.set", appKey, names }),
  );
}

async function applyOne(ctx, change) {
  const { client, state, key } = ctx;
  const appId = change.app === undefined ? undefined : state.apps[change.app].id;
  if (change.op === "database.backups") {
    await client.send(
      "PATCH",
      `/databases/${state.databases[change.db].id}/backups/policy`,
      change.to,
      key(change),
    );
  } else if (change.op === "env.connect") {
    const body = { app_id: appId, variable: change.name, restart: false };
    await client.send(
      "POST",
      `/databases/${state.databases[change.db].id}/connect`,
      body,
      key(change),
    );
  } else if (change.op === "app.port") {
    await client.send("PATCH", `/apps/${appId}`, { port: change.to }, key(change));
  } else if (change.op === "volume.add") {
    await client.send("POST", `/apps/${appId}/volumes`, change.volume, key(change));
  } else if (change.op === "domain.add") {
    await client.send("POST", `/apps/${appId}/domains`, { host: change.host }, key(change));
  } else {
    await cronChange(ctx, change, appId);
  }
}

async function cronChange(ctx, change, appId) {
  const { name, schedule, command, timezone } = change.job;
  const body = {
    name,
    cron: schedule,
    command,
    shell: "sh",
    timezone: timezone ?? "UTC",
    enabled: true,
  };
  await ctx.client.send("POST", `/apps/${appId}/cron`, body, ctx.key(change));
}

async function applyInside(ctx, changes) {
  const envByApp = new Map();
  for (const change of changes) {
    if (change.op === "env.set")
      envByApp.set(change.app, [...(envByApp.get(change.app) ?? []), change]);
  }
  for (const change of changes) {
    if (change.op !== "env.set") await applyOne(ctx, change);
  }
  for (const [appKey, appChanges] of envByApp) await setVariables(ctx, appKey, appChanges);
}

const apiChanges = (changes) => changes.filter((c) => c.sort === "api");

/**
 * Applies the file and returns what was done and what is left for a person.
 *
 * @param {{ client: any, spec: any, env?: Record<string, string | undefined>, generate?: () => string,
 *   runId?: string, log?: (line: string) => void }} options
 */
export async function apply({
  client,
  spec,
  env = process.env,
  generate = generateSecret,
  runId = `${Date.now()}`,
  log = () => {},
}) {
  const ctx = {
    client,
    spec,
    env,
    generate,
    key: keyMaker(spec, runId),
    state: await observe(client, spec),
  };
  const first = apiChanges(diff(spec, ctx.state));
  const missing = missingOperatorSecrets(first, env);
  if (missing.length > 0)
    throw new Error(
      `Set these operator variables first (nothing was changed): ${missing.join(", ")}`,
    );
  const creates = first.filter((c) => CREATES.has(c.op));
  checkBudget(spec, ctx.state, creates);
  for (const change of creates) {
    log(describe(change));
    await create(ctx, change);
  }
  if (creates.length > 0) ctx.state = await observe(client, spec);
  const inside = apiChanges(diff(spec, ctx.state)).filter((c) => !CREATES.has(c.op));
  for (const change of inside) log(describe(change));
  await applyInside(ctx, inside);
  const after = diff(spec, await observe(client, spec));
  const left = apiChanges(after);
  if (left.length > 0)
    throw new Error(`CranL still differs after apply:\n${left.map(describe).join("\n")}`);
  return { done: creates.length + inside.length, rest: after };
}
