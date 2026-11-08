// Mail stage of the monitoring validation: a test alert posted to the Alertmanager comes out as an email with the
// subject, the summary and the runbook link the owner needs. A mail server that keeps what it receives stands in for
// the real one, and the TLS requirement is switched off for it (the only change to the rendered configuration).
import { RUNBOOK_BASE_URL, stackEnv } from "./context.mjs";
import { start, waitFor } from "./docker.mjs";
import { ensure } from "./http.mjs";
import { startSmtpSink } from "./smtp-sink.mjs";

// The link starts with RUNBOOK_BASE_URL, which the validation sets to an address that is not the default.
const RUNBOOK_LINK = RUNBOOK_BASE_URL + "docs/RUNBOOK.md#questifyvalidationtest";

const ALERT_COMMAND = [
  "set -e",
  "/usr/local/bin/render-config.sh",
  "sed -i 's/smtp_require_tls: true/smtp_require_tls: false/' /tmp/alertmanager.yml",
  "alertmanager --config.file=/tmp/alertmanager.yml --storage.path=/tmp/alertmanager --web.listen-address=127.0.0.1:9093 --cluster.listen-address= &",
  "for i in $(seq 1 30); do wget -q -O /dev/null http://127.0.0.1:9093/-/ready && break; sleep 1; done",
  "amtool --alertmanager.url=http://127.0.0.1:9093 alert add alertname=QuestifyValidationTest severity=page instance=validate --annotation='summary=\"Validation alert\"' --annotation='runbook=\"docs/RUNBOOK.md#questifyvalidationtest\"'",
  "sleep 120",
].join("\n");

/** The text of a mail with its quoted-printable encoding undone. */
const decoded = (message) =>
  message
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

export async function checkMail(ctx) {
  const sink = await startSmtpSink();
  try {
    start({
      name: ctx.name("mail"),
      image: ctx.image,
      env: stackEnv(ctx, `host.docker.internal:${sink.port}`),
      entrypoint: "/bin/sh",
      args: ["-c", ALERT_COMMAND],
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
