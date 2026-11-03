// Reads and checks one environment file of ops/cranl/ (T-017, ADR-650). The file declares everything Questify has on
// CranL for that environment; a setting it does not name is drift that `plan` reports. A secret's value is never in
// the file: it says only where the value comes from.
import { readFileSync } from "node:fs";

const NAME = /^[a-z][a-z0-9-]{1,62}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const PLACEHOLDER = /\{([a-z]+)\.(url|host)\}/g;
const DB_TYPES = new Set(["postgresql", "redis"]);
const BACKUP_FREQUENCIES = new Set([
  "hourly",
  "every_6_hours",
  "every_12_hours",
  "daily",
  "weekly",
]);

function fail(file, where, message) {
  throw new Error(`${file}: ${where}: ${message}`);
}

/** The kind of one declared variable: plain, template, generate, operator or database. */
export function envKind(value) {
  if (typeof value === "string") return "plain";
  if (value?.template !== undefined) return "template";
  if (value?.database !== undefined) return "database";
  return value?.secret;
}

export const isSecretKind = (kind) =>
  kind === "generate" || kind === "operator" || kind === "database";

/** The apps a template names, as `{app}.url` or `{app}.host`. */
export function templateApps(template) {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

function checkEnv(file, spec, appKey, env) {
  for (const [name, value] of Object.entries(env)) {
    const where = `apps.${appKey}.env.${name}`;
    if (!ENV_NAME.test(name)) fail(file, where, "an environment name is upper case, digits and _");
    const kind = envKind(value);
    if (!["plain", "template", "generate", "operator", "database"].includes(kind)) {
      fail(
        file,
        where,
        'use a string, {"template"}, {"database"} or {"secret": "generate"|"operator"}',
      );
    }
    if (kind === "database" && spec.databases[value.database] === undefined) {
      fail(file, where, `no database "${value.database}" is declared`);
    }
    if (kind === "template") {
      for (const app of templateApps(value.template)) {
        if (spec.apps[app] === undefined)
          fail(file, where, `the template names an undeclared app "${app}"`);
      }
    }
  }
}

function checkBackups(file, key, backups) {
  if (backups === undefined) return;
  if (!BACKUP_FREQUENCIES.has(backups.frequency))
    fail(file, `databases.${key}.backups`, "unknown frequency");
  if (!Number.isInteger(backups.keep) || backups.keep < 1 || backups.keep > 30) {
    fail(file, `databases.${key}.backups.keep`, "keep 1 to 30 backups");
  }
}

function checkDatabases(file, databases) {
  for (const [key, db] of Object.entries(databases)) {
    if (!NAME.test(db.name ?? "")) fail(file, `databases.${key}.name`, "a lower-case CranL name");
    if (!DB_TYPES.has(db.type)) fail(file, `databases.${key}.type`, "postgresql or redis");
    if (db.type === "redis" && db.backups !== undefined) {
      fail(file, `databases.${key}.backups`, "CranL does not back up Redis");
    }
    checkBackups(file, key, db.backups);
  }
}

function checkApp(file, spec, key, app) {
  const where = `apps.${key}`;
  if (!NAME.test(app.name ?? "")) fail(file, `${where}.name`, "a lower-case CranL name");
  if (!Number.isInteger(app.port)) fail(file, `${where}.port`, "a port number");
  if (typeof app.build_path !== "string" || !app.build_path.startsWith("/")) {
    fail(file, `${where}.build_path`, "a folder of the repository starting with /");
  }
  if (typeof app.dockerfile_path !== "string")
    fail(file, `${where}.dockerfile_path`, "the Dockerfile");
  for (const list of ["volumes", "cron", "domains"]) {
    if (!Array.isArray(app[list]))
      fail(file, `${where}.${list}`, "a list (empty when there is none)");
  }
  checkEnv(file, spec, key, app.env ?? fail(file, `${where}.env`, "missing"));
}

/**
 * Checks a parsed environment file and returns it.
 *
 * @param {any} spec The parsed JSON.
 * @param {string} file The file's name, for the error messages.
 */
export function checkSpec(spec, file = "spec") {
  for (const field of ["environment", "project", "region", "git_url", "branch"]) {
    if (typeof spec[field] !== "string" || spec[field] === "") fail(file, field, "missing");
  }
  if (!spec.git_url.endsWith(".git"))
    fail(file, "git_url", "CranL needs the repository's .git URL");
  if (!Array.isArray(spec.buckets)) fail(file, "buckets", "a list (empty when there is none)");
  checkDatabases(file, spec.databases ?? fail(file, "databases", "missing"));
  for (const [key, app] of Object.entries(spec.apps ?? fail(file, "apps", "missing"))) {
    checkApp(file, spec, key, app);
  }
  return spec;
}

/** Reads and checks ops/cranl/<environment>.json. */
export function loadSpec(path) {
  return checkSpec(JSON.parse(readFileSync(path, "utf8")), path);
}

/** The operator's environment variable that carries a secret: SECRET_<APP>_<NAME>, like SECRET_API_QR_SECRET. */
export const operatorVariable = (appKey, name) => `SECRET_${appKey.toUpperCase()}_${name}`;

/**
 * Fills a template from the apps' public addresses; undefined while a named app has no address yet.
 *
 * @param {string} template
 * @param {Record<string, string | undefined>} urls The app key to its public https origin.
 */
export function fillTemplate(template, urls) {
  let missing = false;
  const value = template.replaceAll(PLACEHOLDER, (_, app, part) => {
    const url = urls[app];
    if (url === undefined) {
      missing = true;
      return "";
    }
    return part === "url" ? url : new URL(url).hostname.split(".")[0];
  });
  return missing ? undefined : value;
}
