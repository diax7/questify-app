// Checks the monitoring stack's files without CranL and without a secret (T-018b, ADR-625). It builds the three images
// from their folders (what CranL does), then:
//   1. runs the programs' own checkers on the files: otelcol validate; promtool check config / check rules / test
//      rules; amtool check-config and the alert routes; shellcheck and shfmt on the scripts; the apps' refusal of a
//      bad or missing setting;
//   2. starts the stack on a private Docker network and sends OTLP like the API does, to prove that the collector
//      refuses a missing, wrong or empty token; attributes off the API's closed list never reach Prometheus or the
//      traces output; metric names and labels are the ones the alert rules use; Prometheus loads all 20 rules, finds
//      its Alertmanager and refuses anyone without the password; Grafana needs a login, reaches Prometheus and
//      answers every dashboard query; the Alertmanager mails a test alert; with alert email off (no ALERT_SMTP_HOST,
//      Q-581) the app starts from the two metrics settings, evaluates the rules and sends nothing, while a partial
//      set of email settings is refused; and the container stops if the Alertmanager dies (so CranL restarts it).
// Needs Docker (the pinned images are pulled on first use) and about two minutes. Run: pnpm monitoring:validate
import { join } from "node:path";
import { buildImage, cleanUp, createNetwork } from "./lib/docker.mjs";
import { createContext, MONITORING } from "./lib/context.mjs";
import { checkGrafana } from "./lib/grafana-checks.mjs";
import { checkMail } from "./lib/mail-checks.mjs";
import {
  checkEmptyTokenSlot,
  checkIngestAuth,
  checkListeners,
  checkNoEmailMode,
  checkPrometheus,
  checkStoredSeries,
  checkSupervisor,
  checkTracesOutput,
  startStack,
} from "./lib/pipeline-checks.mjs";
import {
  checkCollectorConfig,
  checkGrafanaRefusals,
  checkNoEmailRender,
  checkPartialEmailRefusals,
  checkPrometheusApp,
  checkRenderRefusals,
  checkShellScripts,
} from "./lib/static-checks.mjs";

const say = (text) => process.stdout.write(`${text}\n`);

function buildImages(ctx) {
  for (const app of ["collector", "prometheus", "grafana"]) {
    buildImage(ctx.image(app), join(MONITORING, app));
  }
}

async function runLiveStages(ctx, stages) {
  createNetwork(ctx.network);
  const stack = await stages.run("the stack starts", () => startStack(ctx));
  if (stack === undefined) return;
  await stages.run("collector: the bearer token is required", () => checkIngestAuth(ctx, stack));
  await stages.run("collector: an empty token slot opens nothing", () =>
    checkEmptyTokenSlot(ctx, stack),
  );
  await stages.run("prometheus: names, labels and the closed list of attributes", () =>
    checkStoredSeries(ctx, stack),
  );
  await stages.run("collector: traces carry only the closed list", () => checkTracesOutput(stack));
  await stages.run("prometheus: 20 rules, the Alertmanager, the password", () =>
    checkPrometheus(ctx, stack),
  );
  await stages.run("prometheus app: the Alertmanager is on the loopback only, health check", () =>
    checkListeners(stack),
  );
  await stages.run("grafana: login, data source, dashboard, every query", () =>
    checkGrafana(ctx, stack),
  );
  await stages.run("alertmanager: a test alert is mailed", () => checkMail(ctx));
  await stages.run("prometheus app: alert email off starts, evaluates, sends nothing", () =>
    checkNoEmailMode(ctx),
  );
  await stages.run("prometheus app: it stops when the Alertmanager dies", () =>
    checkSupervisor(stack),
  );
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
        return result;
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
    await stages.run("the three images build", () => buildImages(ctx));
    await stages.run("collector: otelcol validate", () => checkCollectorConfig(ctx));
    await stages.run("scripts: shellcheck and shfmt", () => checkShellScripts());
    await stages.run("prometheus app: promtool, amtool, routes, rule tests", () =>
      checkPrometheusApp(ctx),
    );
    await stages.run("apps refuse a bad or missing setting", () => {
      checkRenderRefusals(ctx);
      checkGrafanaRefusals(ctx);
    });
    await stages.run("prometheus app: alert email off needs no ALERT_* setting", () =>
      checkNoEmailRender(ctx),
    );
    await stages.run("prometheus app: a partial set of email settings is refused", () =>
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
