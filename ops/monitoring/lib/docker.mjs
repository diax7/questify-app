// Docker helpers of the monitoring validation (ops/monitoring/validate.mjs). Everything it starts is named with a run id
// and removed when the run ends, whether it passed or not (the image it built too; the pinned base images stay).
import { spawnSync } from "node:child_process";

const containers = [];
const images = [];

/** Runs `docker <args>`; throws with the command's start and its output unless `allowFailure`. */
export function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new Error(`docker is not available: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `docker ${args.slice(0, 2).join(" ")} failed with status ${result.status}:\n${result.stdout}${result.stderr}`,
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function buildImage(tag, directory) {
  docker(["build", "--quiet", "--tag", tag, directory]);
  images.push(tag);
}

const envArgs = (env) => Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

/**
 * Starts a container in the background. `publish` lists container ports to open on 127.0.0.1 (the host port is
 * chosen by Docker, read it with `hostPort`); `mounts` are `{ source, target }` read-only bind mounts; `tmpfs` lists
 * `target[:options]` memory file systems; `network` is a Docker network mode (`host` puts the container on the
 * machine's own network, so it reaches a program on the machine's 127.0.0.1).
 */
export function start({
  name,
  image,
  env = {},
  publish = [],
  mounts = [],
  tmpfs = [],
  entrypoint,
  args = [],
  network,
}) {
  const command = ["run", "--detach", "--name", name];
  if (network !== undefined) command.push("--network", network);
  command.push("--add-host", "host.docker.internal:host-gateway");
  command.push(...envArgs(env));
  for (const port of publish) command.push("--publish", `127.0.0.1::${port}`);
  for (const { source, target } of mounts) {
    command.push("--mount", `type=bind,source=${source},target=${target},readonly`);
  }
  for (const target of tmpfs) command.push("--tmpfs", target);
  if (entrypoint !== undefined) command.push("--entrypoint", entrypoint);
  docker([...command, image, ...args]);
  containers.push(name);
}

/** Runs a throw-away container and returns its output; its exit status is the result's `status`. */
export function runOnce({ image, env = {}, mounts = [], entrypoint, args = [] }) {
  const command = [
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    ...envArgs(env),
  ];
  for (const { source, target } of mounts) {
    command.push("--mount", `type=bind,source=${source},target=${target},readonly`);
  }
  if (entrypoint !== undefined) command.push("--entrypoint", entrypoint);
  return docker([...command, image, ...args], { allowFailure: true });
}

export function hostPort(name, containerPort) {
  const { stdout } = docker(["port", name, `${containerPort}/tcp`]);
  const port = /:(\d+)\s*$/m.exec(stdout.trim().split("\n")[0] ?? "");
  if (port === null) throw new Error(`No host port is published for ${name}:${containerPort}.`);
  return Number(port[1]);
}

export const logsOf = (name) => {
  const { stdout, stderr } = docker(["logs", name], { allowFailure: true });
  return `${stdout}${stderr}`;
};

export function isRunning(name) {
  const { stdout } = docker(["inspect", "--format", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  return stdout.trim() === "true";
}

/** The exit status of a container that has stopped. */
export function exitCodeOf(name) {
  const { stdout } = docker(["inspect", "--format", "{{.State.ExitCode}}", name]);
  return Number(stdout.trim());
}

/** Runs a shell command inside a running container and returns what it printed; throws when it fails. */
export const inside = (name, command) => docker(["exec", name, "/bin/sh", "-c", command]).stdout;

/** Polls until `check` returns a truthy value; throws `what` with the last error when the time is up. */
export async function waitFor(what, check, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : "."}`);
}

export function cleanUp() {
  for (const name of containers.splice(0)) docker(["rm", "--force", name], { allowFailure: true });
  for (const tag of images.splice(0)) docker(["rmi", tag], { allowFailure: true });
}
