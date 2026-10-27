import { randomUUID } from "node:crypto";
import {
  adminInvitationDetailSchema,
  adminInvitationQueueSchema,
  invitationApprovedSchema,
  invitationCampaignSchema,
  invitationCampaignsSchema,
  invitationOpenSchema,
} from "@questify/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationToken } from "#src/invitation-campaigns/message";
import type { SmsSender } from "#src/players/sms";
import {
  browserHeaders,
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { invitationFixture, type InvitationFixture } from "#test/support/invitations";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Method = "GET" | "POST" | "DELETE";

/**
 * Questify invitations over HTTP (T-409): the owner's request with its Idempotency-Key and every refusal mapped, the
 * team's list with rounded counts only, cross-tenant and limited-editor 404s, the console's queue, detail, approval
 * (event_renamed, the name rule, the moved send time), refusal and cancel, and the landing page's open with its bucket.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("invitations over HTTP", () => {
  let f: InvitationFixture;
  let test: TestApp;
  const cookies: Record<"owner" | "editor" | "scoped" | "ownerB" | "admin", string> = {
    owner: "",
    editor: "",
    scoped: "",
    ownerB: "",
    admin: "",
  };
  const promo: SmsSender = { name: "promo", send: async () => ({ kind: "sent" }) };

  beforeAll(async () => {
    f = await invitationFixture();
    await f.switchOn();
    test = await startApp(f.db, false, {}, { promoSmsSender: promo });
    const member = async (
      email: string,
      organizer: string,
      role: string,
      scope: string[] | null,
    ) => {
      const id = await createStaff(f.db.owner, { email });
      await f.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
        [organizer, id, role, scope],
      );
      return signInFully(test, email);
    };
    // Each organizer has one owner already (the fixture's): give that account an email and the test password.
    const signable = async (staff: string, email: string) => {
      const made = await createStaff(f.db.owner, { email: `tmp.${email}` });
      await f.owner(
        `UPDATE staff_user SET email = $2, password_hash = (SELECT password_hash FROM staff_user WHERE id = $3)
         WHERE id = $1`,
        [staff, email, made],
      );
      await f.owner("DELETE FROM staff_user WHERE id = $1", [made]);
      return signInFully(test, email);
    };
    cookies.owner = await signable(f.ownerA, "owner@iv.test");
    cookies.ownerB = await signable(f.ownerB, "ownerb@iv.test");
    cookies.editor = await member("editor@iv.test", f.ids.orgA, "editor", null);
    cookies.scoped = await member("scoped@iv.test", f.ids.orgA, "editor", [f.ids.eventA]);
    await createStaff(f.db.owner, { email: "admin@iv.test", admin: true });
    cookies.admin = await signInFully(test, "admin@iv.test");
  });
  afterAll(async () => {
    await test.close();
    await f.close();
  });

  const call = (
    cookie: string,
    method: Method,
    url: string,
    payload?: unknown,
    key: string | null = randomUUID(),
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(
        cookie,
        key === null || method === "GET" ? {} : { "idempotency-key": key },
      ),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const base = (event: string, organizer = f.ids.orgA) =>
    `/v1/organizers/${organizer}/events/${event}/invitation-campaigns`;
  const ask = (event: string, body: object = { size: 50 }, key: string | null = randomUUID()) =>
    call(cookies.owner, "POST", base(event), body, key);
  const detail = async (campaign: string) =>
    adminInvitationDetailSchema.parse(
      (await call(cookies.admin, "GET", `/v1/admin/invitation-campaigns/${campaign}`)).json(),
    );
  const approve = (campaign: string, body: object) =>
    call(cookies.admin, "POST", `/v1/admin/invitation-campaigns/${campaign}/approve`, body);
  const approval = async (campaign: string, over: object = {}) => {
    const shown = await detail(campaign);
    return {
      channels: ["sms"],
      cap: 100,
      sendAt: new Date(Date.now() + 3600_000).toISOString(),
      expectedNameAr: shown.names.ar.name,
      expectedNameEn: shown.names.en.name,
      ...over,
    };
  };
  const open = (token: unknown, ip = freshIp()) =>
    test.app.inject({
      method: "POST",
      url: "/v1/public/invitation-open",
      headers: browserHeaders({ "x-forwarded-for": ip }),
      payload: { token },
    });

  const requested = async () => {
    const event = await f.eligibleEvent();
    const answer = await ask(event);
    expect(answer.statusCode).toBe(201);
    return { event, campaign: invitationCampaignSchema.parse(answer.json().campaign) };
  };

  describe("the owner's side", () => {
    it("requests a campaign and shows it to the owner and editors with no exact count, never cached", async () => {
      const { event, campaign } = await requested();
      expect(campaign).toMatchObject({
        state: "requested",
        size: 50,
        counts: { sent: null, opened: null, joined: null },
      });
      for (const cookie of [cookies.owner, cookies.editor]) {
        const list = await call(cookie, "GET", base(event));
        expect(list.statusCode).toBe(200);
        expect(list.headers["cache-control"]).toBe("no-store");
        expect(invitationCampaignsSchema.parse(list.json())).toMatchObject({ enabled: true });
      }
    });

    it("answers 404 to a limited editor outside the event and to another organizer, 403 to an editor's request", async () => {
      const { event } = await requested();
      expect((await call(cookies.scoped, "GET", base(event))).statusCode).toBe(404);
      expect((await call(cookies.ownerB, "GET", base(event))).statusCode).toBe(404);
      expect((await call(cookies.ownerB, "GET", base(event, f.ids.orgB))).statusCode).toBe(404);
      expect(
        (await call(cookies.ownerB, "POST", base(event, f.ids.orgB), { size: 50 })).statusCode,
      ).toBe(404);
      const editor = await call(cookies.editor, "POST", base(await f.eligibleEvent()), {
        size: 50,
      });
      expect(editor.statusCode).toBe(403);
      expect(editor.json()).toMatchObject({ code: "owner_only" });
    });

    it("replays a request with the same key, and needs one", async () => {
      const event = await f.eligibleEvent();
      const key = randomUUID();
      const first = await ask(event, { size: 60 }, key);
      const again = await ask(event, { size: 60 }, key);
      expect(again.statusCode).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      expect((await ask(event, { size: 60 }, null)).statusCode).toBe(400);
      expect(
        await f.owner("SELECT 1 FROM invitation_campaign WHERE event_id = $1", [event]),
      ).toHaveLength(1);
    });

    it.each([
      ["a second open campaign", 409, "invitation_open"],
      ["an unlisted event", 409, "event_not_eligible"],
      ["an unknown city", 422, "invalid_invitation"],
      ["a size under 50", 400, "invalid_request"],
      ["a name with a web address", 422, "event_name"],
      ["the platform switch off", 403, "feature_off"],
    ])("refuses %s with %i %s", async (refused, status, code) => {
      const event = await f.eligibleEvent();
      let body: object = { size: 50 };
      if (refused === "a second open campaign") await ask(event);
      if (refused === "an unlisted event")
        await f.owner("UPDATE event SET access = 'unlisted' WHERE id = $1", [event]);
      if (refused === "an unknown city") body = { size: 50, cityId: "sa-nowhere" };
      if (refused === "a size under 50") body = { size: 49 };
      if (refused === "a name with a web address") {
        await f.owner("UPDATE event SET name_en = 'Win at pay-now.co' WHERE id = $1", [event]);
      }
      if (refused === "the platform switch off") await f.switchOn(false);
      try {
        const answer = await ask(event, body);
        expect(answer.statusCode).toBe(status);
        expect(answer.json()).toMatchObject({ code });
        if (code === "event_not_eligible")
          expect(answer.json().details).toEqual({ reason: "not_public" });
        if (code === "invalid_invitation")
          expect(answer.json().details).toEqual({ field: "cityId" });
        if (code === "event_name") {
          expect(answer.json().details).toEqual({ language: "en", reason: "looks_like_address" });
        }
      } finally {
        await f.switchOn();
      }
    });

    it("lets the owner withdraw a campaign that has not started (204), once", async () => {
      const { event, campaign } = await requested();
      const url = `${base(event)}/${campaign.id}`;
      expect((await call(cookies.editor, "DELETE", url)).statusCode).toBe(403);
      expect((await call(cookies.owner, "DELETE", url)).statusCode).toBe(204);
      const again = await call(cookies.owner, "DELETE", url);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "wrong_state" });
      expect(
        (await call(cookies.owner, "DELETE", `${base(event)}/${randomUUID()}`)).statusCode,
      ).toBe(404);
    });
  });

  describe("the console", () => {
    it("answers 404 to anyone but an active platform admin", async () => {
      const { campaign } = await requested();
      for (const url of [
        "/v1/admin/invitation-campaigns",
        `/v1/admin/invitation-campaigns/${campaign.id}`,
      ]) {
        expect((await call(cookies.owner, "GET", url)).statusCode).toBe(404);
      }
      expect((await approve(campaign.id, await approval(campaign.id))).statusCode).toBe(200);
      const owned = await call(
        cookies.owner,
        "POST",
        `/v1/admin/invitation-campaigns/${campaign.id}/cancel`,
        {
          note: "x",
        },
      );
      expect(owned.statusCode).toBe(404);
    });

    it("lists the queue and shows one campaign with the names' verdicts and the rendered messages", async () => {
      await f.isolate();
      await f.optedIn(52);
      const { campaign } = await requested();
      const queue = await call(cookies.admin, "GET", "/v1/admin/invitation-campaigns");
      expect(queue.headers["cache-control"]).toBe("no-store");
      expect(adminInvitationQueueSchema.parse(queue.json()).campaigns.map((c) => c.id)).toContain(
        campaign.id,
      );
      const shown = await detail(campaign.id);
      expect(shown).toMatchObject({
        estimate: 52,
        availableChannels: ["sms"],
        eventIssue: null,
        hold: null,
      });
      expect(shown.names.ar.issue).toBeNull();
      expect(shown.messages.ar?.text.startsWith(`دعوة إلى ${shown.names.ar.name ?? ""}: `)).toBe(
        true,
      );
      expect(shown.messages.en?.parts).toBeLessThanOrEqual(3);
    });

    it("preview, rename, approve → 409 event_renamed; approving the new text works", async () => {
      const { event, campaign } = await requested();
      const stale = await approval(campaign.id);
      await f.owner("UPDATE event SET name_en = 'Renamed Fest' WHERE id = $1", [event]);
      const refused = await approve(campaign.id, stale);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "event_renamed" });
      const fresh = await approve(campaign.id, await approval(campaign.id));
      expect(fresh.statusCode).toBe(200);
      expect(invitationApprovedSchema.parse(fresh.json()).campaign.approvedNames.en).toBe(
        "Renamed Fest",
      );
    });

    it("refuses names the SMS cannot carry (422 event_name) and moves a send time out of quiet hours", async () => {
      const { event, campaign } = await requested();
      await f.owner("UPDATE event SET name_ar = 'اتصل على 0501234567' WHERE id = $1", [event]);
      expect((await detail(campaign.id)).names.ar.issue).toBe("looks_like_phone");
      const refused = await approve(campaign.id, await approval(campaign.id));
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "event_name",
        details: { language: "ar", reason: "looks_like_phone" },
      });

      const second = await requested();
      const night = new Date(Date.now() + 26 * 3600_000);
      night.setUTCHours(20, 0, 0, 0);
      const moved = await approve(
        second.campaign.id,
        await approval(second.campaign.id, { sendAt: night.toISOString() }),
      );
      expect(moved.statusCode).toBe(200);
      const answer = invitationApprovedSchema.parse(moved.json());
      expect(answer.sendAtMoved).toBe(true);
      expect(new Date(answer.campaign.sendAt ?? "").getTime()).toBeGreaterThan(night.getTime());
    });

    it("maps the approval's own refusals: wrong state, a bad field, a malformed body", async () => {
      const { campaign } = await requested();
      const late = await approve(
        campaign.id,
        await approval(campaign.id, { sendAt: "2099-01-01T12:00:00+03:00" }),
      );
      expect(late.statusCode).toBe(422);
      expect(late.json()).toMatchObject({ code: "invalid_approval", details: { field: "sendAt" } });
      expect(
        (await approve(campaign.id, await approval(campaign.id, { cap: 10 }))).statusCode,
      ).toBe(400);
      expect((await approve(campaign.id, await approval(campaign.id))).statusCode).toBe(200);
      const twice = await approve(campaign.id, await approval(campaign.id));
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ code: "wrong_state" });
      expect((await approve(randomUUID(), await approval(campaign.id))).statusCode).toBe(404);
    });

    it("refuses and cancels with a note the owner reads", async () => {
      const refused = await requested();
      const answer = await call(
        cookies.admin,
        "POST",
        `/v1/admin/invitation-campaigns/${refused.campaign.id}/refuse`,
        {
          note: "Not this month",
        },
      );
      expect(answer.statusCode).toBe(200);
      expect(answer.json().campaign).toMatchObject({ state: "refused", note: "Not this month" });
      const [listed] = invitationCampaignsSchema.parse(
        (await call(cookies.owner, "GET", base(refused.event))).json(),
      ).campaigns;
      expect(listed).toMatchObject({ state: "refused", note: "Not this month" });
      const cancelled = await requested();
      const stop = await call(
        cookies.admin,
        "POST",
        `/v1/admin/invitation-campaigns/${cancelled.campaign.id}/cancel`,
        {
          note: "Event moved",
        },
      );
      expect(stop.json().campaign).toMatchObject({ state: "cancelled", endReason: "admin" });
      const empty = await call(
        cookies.admin,
        "POST",
        `/v1/admin/invitation-campaigns/${cancelled.campaign.id}/cancel`,
        {
          note: "  ",
        },
      );
      expect(empty.statusCode).toBe(400);
    });
  });

  describe("the landing page's open", () => {
    it("answers the public event card for a sent message's token, never cached, and counts it once", async () => {
      const { campaign, event } = await f.launch(50);
      const [claimed] = await f.claimAt(1);
      await f.ack(claimed ?? { recipient_id: "", lease: "" }, "sent");
      const answer = await open(invitationToken(claimed?.link ?? ""));
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(invitationOpenSchema.parse(answer.json()).event.id).toBe(event);
      await open(invitationToken(claimed?.link ?? ""));
      expect((await f.campaignRow(campaign)).opened).toBe(1);
    });

    it("answers 400 for a malformed token and 404 invitation_ended for an unknown one", async () => {
      expect((await open("short")).statusCode).toBe(400);
      const unknown = await open(invitationToken(randomUUID()));
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: "invitation_ended" });
    });

    it("allows 120 tries an hour per address, counted before the token is read", async () => {
      const ip = freshIp();
      for (let i = 0; i < 120; i += 1) {
        expect((await open("bad", ip)).statusCode).toBe(400);
      }
      expect((await open(invitationToken(randomUUID()), ip)).statusCode).toBe(429);
      expect((await open(invitationToken(randomUUID()))).statusCode).toBe(404);
    });
  });
});
