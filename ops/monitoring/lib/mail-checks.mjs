// Mail stage of the monitoring validation: a test alert posted to the Alertmanager comes out as an email with the
// subject, the summary and the runbook link the owner needs. A mail server that keeps what it receives stands in for
// the real one, and the TLS requirement is switched off for it (the only change to the rendered configuration).
import { createServer } from "node:net";
import { RUNBOOK_BASE_URL, stackEnv } from "./context.mjs";
import { start, waitFor } from "./docker.mjs";
import { ensure } from "./http.mjs";
import { startSmtpSink } from "./smtp-sink.mjs";

// The link starts with RUNBOOK_BASE_URL, which the validation sets to an address that is not the default.
const RUNBOOK_LINK = RUNBOOK_BASE_URL + "docs/RUNBOOK.md#questifyvalidationtest";

// The Alertmanager of this check listens on `webPort`: 9093 is what the app uses, and on the host network (below) that
// port may belong to another program on a shared machine.
const alertCommand = (webPort) =>
  [
    "set -e",
    "/usr/local/bin/render-config.sh",
    "sed -i 's/smtp_require_tls: true/smtp_require_tls: false/' /tmp/alertmanager.yml",
    `alertmanager --config.file=/tmp/alertmanager.yml --storage.path=/tmp/alertmanager --web.listen-address=127.0.0.1:${webPort} --cluster.listen-address= &`,
    `for i in $(seq 1 30); do wget -q -O /dev/null http://127.0.0.1:${webPort}/-/ready && break; sleep 1; done`,
    `amtool --alertmanager.url=http://127.0.0.1:${webPort} alert add alertname=QuestifyValidationTest severity=page instance=validate --annotation='summary="Validation alert"' --annotation='runbook="docs/RUNBOOK.md#questifyvalidationtest"'`,
    "sleep 120",
  ].join("\n");

/** A port nothing on the machine listens on now. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Where the mail container finds the sink. On Linux the container joins the host network and the sink listens on
// 127.0.0.1 only: the bridge route (host.docker.internal) is shut by a host firewall that drops the bridge's traffic to
// the machine, as ufw does by default, and the mail then never arrives (the stage timed out on such a server). Docker
// Desktop (Windows, macOS) has no such firewall and its host network lies inside a VM, so it keeps the bridge.
const onHostNetwork = process.platform === "linux";

/** The text of a mail with its quoted-printable encoding undone. */
const decoded = (message) =>
  message
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

export async function checkMail(ctx) {
  const sink = await startSmtpSink(onHostNetwork ? { host: "127.0.0.1" } : {});
  try {
    const smtpHost = `${onHostNetwork ? "127.0.0.1" : "host.docker.internal"}:${sink.port}`;
    start({
      name: ctx.name("mail"),
      image: ctx.image,
      env: stackEnv(ctx, smtpHost),
      entrypoint: "/bin/sh",
      args: ["-c", alertCommand(await freePort())],
      network: onHostNetwork ? "host" : undefined,
    });
    await waitFor("the alert mail", async () => sink.messages.length > 0, {
      timeoutMs: 90_000,
      intervalMs: 1000,
    });
    const mail = decoded(sink.messages[0]);
    ensure(
      /^Subject: \[Questify validation PAGE\] QuestifyValidationTest$/m.test(mail),
      `The subject is not the expected one:\n${mail.slice(0, 600)}`,
    );
    for (const expected of [
      "QuestifyValidationTest (page): firing",
      "Validation alert",
      "instance=validate",
      RUNBOOK_LINK,
    ]) {
      ensure(
        mail.includes(expected),
        `The mail does not contain "${expected}":\n${mail.slice(0, 900)}`,
      );
    }
    ensure(/^To: owner@example\.test$/m.test(mail), "The mail went to the wrong address.");
  } finally {
    sink.close();
  }
}
