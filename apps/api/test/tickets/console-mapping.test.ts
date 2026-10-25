import { describe, expect, it } from "vitest";
import { consoleTicket, consoleTickets } from "#src/tickets/console";
import { fakePool } from "#test/support/fake-pool";

const AT = new Date("2030-01-01T10:00:00Z");
const row = {
  id: "7",
  kind: "app_problem",
  preview: "Crash",
  marked: false,
  status: "open",
  outcome: null,
  created_at: AT,
  closed_at: null,
  username: "sara",
  organizer_id: "org",
  organizer_name: "Najd",
  event_id: "event",
  event_name_ar: "مهرجان",
  event_name_en: null,
  quest_title_ar: "ابحث",
  quest_title_en: null,
  reported_username: null,
  escalated_at: AT,
  escalated_by: null,
  app_version: "1.4.0",
  platform: "android",
  os_version: "16",
  device_model: "Pixel 9",
  body: "Crash",
  reply: null,
  event_status: "live",
  escalation_note: null,
  returned_at: AT,
  return_note: null,
  answered_by: null,
};

async function detail(changes: Partial<typeof row> | Record<string, unknown>) {
  const { pool } = fakePool(() => ({ rows: [{ ...row, ...changes }] }));
  const result = await consoleTicket({ pool }, "66666666-6666-4666-8666-666666666666", {
    ticketId: "7",
    requestId: "request",
  });
  expect(result.kind).toBe("done");
  if (result.kind !== "done") throw new Error("Ticket read refused");
  return result.value;
}

describe("console ticket presentation", () => {
  it.each(["event_id", "organizer_id"])(
    "omits an event unless its %s is present",
    async (field) => {
      expect((await detail({ [field]: null })).event).toBeNull();
    },
  );

  it.each(["app_version", "platform", "os_version"])(
    "omits incomplete device facts without %s",
    async (field) => {
      expect((await detail({ [field]: null })).device).toBeNull();
    },
  );

  it("keeps Arabic-only quest titles and complete device facts in queue previews", async () => {
    const { pool } = fakePool((sql) => ({
      rows: sql.includes("counts")
        ? [{ open: 1, closed: 0, open_direct: 1, open_escalated: 0 }]
        : [row],
    }));
    expect(
      await consoleTickets({ pool }, "66666666-6666-4666-8666-666666666666", {
        status: "open",
        kind: null,
        source: null,
        cursor: null,
        limit: 50,
        requestId: "request",
      }),
    ).toMatchObject({
      kind: "done",
      value: {
        tickets: [
          {
            questTitle: { ar: "ابحث", en: null },
            device: { appVersion: "1.4.0", platform: "android", osVersion: "16", model: "Pixel 9" },
          },
        ],
      },
    });
  });

  it("supplies empty note text when a hop has a timestamp but its note is null", async () => {
    expect(await detail({})).toMatchObject({
      escalation: { at: AT, by: null, note: "" },
      returned: { at: AT, note: "" },
    });
  });
});
