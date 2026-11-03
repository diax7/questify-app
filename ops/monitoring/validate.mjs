// Checks the monitoring app's files without CranL and without a secret (T-018b, ADR-625, ADR-626). It builds the one
// image from ops/monitoring/stack (what CranL does), then:
//   1. runs the programs' own checkers on the files, in the image: promtool check config / check rules / test rules;
//      amtool check-config and the alert routes; caddy validate and fmt; shellcheck and shfmt on the scripts; the
//      app's refusal of a bad or missing setting (none of them printed);
//   2. starts the app and sends OTLP to its one public port like the API does, to prove that Prometheus refuses a
//      missing, wrong or empty password; the API's metrics arrive with the names and the labels the alert rules use
//      and no label off the API's closed list; Prometheus loads all 20 rules and finds its Alertmanager; only Caddy's
//      port is open outside the machine; Grafana, under /grafana, needs a login, reaches Prometheus and answers every
//      dashboard query; the Alertmanager mails a test alert; with alert email off (no ALERT_SMTP_HOST, Q-581) the app
//      starts from the metrics and Grafana settings, evaluates the rules and sends nothing, while a partial set of
//      email settings is refused; Prometheus stores the off-list attributes it is sent (the premise of ADR-626); a
//      stop signal ends the container cleanly, and the death of any of the four programs ends it with an error (so
//      CranL restarts it).
// Everything started is removed at the end. Needs Docker (the pinned images are pulled on first use) and about five
// minutes. Run: pnpm monitoring:validate
import { buildImage, cleanUp, docker } from "./lib/docker.mjs";
import { createContext, STACK, stackEnvWithoutEmail } from "./lib/context.mjs";
import { checkGrafana } from "./lib/grafana-checks.mjs";
import { checkMail } from "./lib/mail-checks.mjs";
import {
  checkClosedDoors,
  checkGracefulStop,
  checkIngestAuth,
  checkListeners,
  checkNoEmailMode,
  checkOffListIsStored,
  checkProgramDeath,
  checkPrometheus,
  PROGRAMS,
  checkStoredSeries,
  startApp,
  startStack,
  startVictim,
} from "./lib/pipeline-checks.mjs";
import {
  checkNoEmailRender,
  checkPartialEmailRefusals,
  checkRenderRefusals,
  checkShellScripts,
  checkStackFiles,
} from "./lib/static-checks.mjs";

const say = (text) => process.stdout.write(`${text}\n`);

async function runNoEmailStages(ctx, stages) {
  const app = await stages.run("alert email off: the app starts", () =>
    startApp(ctx, ctx.name("no-email"), stackEnvWithoutEmail(ctx)),
  );
  if (app === undefined) return;
  await stages.run("alert email off: evaluates, finds the Alertmanager, sends nothing", () =>
    checkNoEmailMode(ctx, app),
  );
  await stages.run("prometheus: stores the off-list attributes it is sent (ADR-626)", () =>
    checkOffListIsStored(ctx, app),
  );
  docker(["rm", "--force", app.name], { allowFailure: true });
}

async function runSupervisorStages(ctx, stages, stack) {
  await stages.run("a stop signal stops every program and ends the container cleanly", () =>
    checkGracefulStop(stack),
  );
  const victims = await stages.run("four copies start, one per program to kill", () =>
    Promise.all(PROGRAMS.map((program) => startVictim(ctx, program))),
  );
  if (victims === undefined) return;
  for (const [index, program] of PROGRAMS.entries()) {
    const app = victims[index];
    await stages.run(`the container stops when ${program} dies`, () =>
      checkProgramDeath(app, program),
    );
  }
}

async function runLiveStages(ctx, stages) {
  const stack = await stages.run("the app starts", () => startStack(ctx));
  if (stack === undefined) return;
  await stages.run("otlp: only the password opens the door", () => checkIngestAuth(ctx, stack));
  await stages.run("otlp: traces, remote write, lifecycle and admin APIs are closed", () =>
    checkClosedDoors(ctx, stack),
  );
  await stages.run("prometheus: names, labels and the closed list of attributes", () =>
    checkStoredSeries(ctx, stack),
  );
  await stages.run("prometheus: 20 rules, the Alertmanager, the password", () =>
    checkPrometheus(ctx, stack),
  );
  await stages.run("app: only Caddy listens outside the machine, health check", () =>
    checkListeners(stack),
  );
  await stages.run("grafana: /grafana, login, data source, dashboard, every query", () =>
    checkGrafana(ctx, stack),
  );
  await stages.run("alertmanager: a test alert is mailed", () => checkMail(ctx));
  await runNoEmailStages(ctx, stages);
  await runSupervisorStages(ctx, stages, stack);
}

function createStages() {
  const failures = [];
  return {
    failures,
    async run(name, work) {
      const started = Date.now();
      try {
        const result = await work();
        say(`ok      ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        return result ?? true;
      } catch (error) {
        failures.push(name);
        say(`FAILED  ${name}\n${error.message}\n`);
        return undefined;
      }
    },
  };
}

async function main() {
  const ctx = createContext();
  const stages = createStages();
  try {
    await stages.run("the image builds", () => buildImage(ctx.image, STACK));
    await stages.run("scripts: shellcheck and shfmt", () => checkShellScripts());
    await stages.run("app files: promtool, amtool, routes, rule tests, Caddyfile", () =>
      checkStackFiles(ctx),
    );
    await stages.run("the app refuses a bad or missing setting", () => checkRenderRefusals(ctx));
    await stages.run("alert email off needs no ALERT_* setting", () => checkNoEmailRender(ctx));
    await stages.run("a partial set of email settings is refused", () =>
      checkPartialEmailRefusals(ctx),
    );
    if (stages.failures.length === 0) {
      await runLiveStages(ctx, stages);
    } else {
      say("The live stages were not run because a file check failed.");
    }
  } finally {
    cleanUp();
  }
  if (stages.failures.length > 0) {
    say(`\n${stages.failures.length} stage(s) failed.`);
    process.exitCode = 1;
  } else {
    say("\nAll monitoring checks passed.");
  }
}

await main();
