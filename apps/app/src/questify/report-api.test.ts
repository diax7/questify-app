import { describe, expect, it } from "vitest";
import { reportBody, sendReport } from "#src/questify/report-api.ts";

const ID = "6f1f8a3e-58f4-4b55-9f0c-3a3a8c6f2f10";

type Sent = { method: string; path: string; body?: unknown; headers?: Record<string, string> };

function sessionAnswering(answer: Record<string, unknown>) {
  const sent: Sent[] = [];
  return {
    sent,
    session: {
      request: async (request: Sent) => {
        sent.push(request);
        return answer as never;
      },
    },
  };
}

describe("reporting (T-705b)", () => {
  it("sends a row by id, a name with its event, and a note only when written", () => {
    expect(reportBody({ kind: "quest", targetId: ID }, "spam", "  ")).toEqual({
      kind: "quest",
      targetId: ID,
      reason: "spam",
    });
    expect(
      reportBody({ kind: "username", username: "rude", eventId: ID }, "hateful", " Look "),
    ).toEqual({ kind: "username", username: "rude", eventId: ID, reason: "hateful", note: "Look" });
    expect(reportBody({ kind: "username", username: "rude" }, "other", "")).toEqual({
      kind: "username",
      username: "rude",
      reason: "other",
    });
  });

  it("posts with an Idempotency-Key and tells sent, the caps and a failure apart", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 201, body: { status: "received" } });
    expect(await sendReport(ok.session, { kind: "event", targetId: ID }, "spam", "")).toBe("sent");
    expect(ok.sent[0]).toMatchObject({ method: "POST", path: "/v1/reports" });
    expect(ok.sent[0]?.headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const capped = sessionAnswering({ kind: "error", status: 429 });
    expect(await sendReport(capped.session, { kind: "event", targetId: ID }, "spam", "")).toBe(
      "limit",
    );
    const down = sessionAnswering({ kind: "network" });
    expect(await sendReport(down.session, { kind: "event", targetId: ID }, "spam", "")).toBe(
      "failed",
    );
  });
});
