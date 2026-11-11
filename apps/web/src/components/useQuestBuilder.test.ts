import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const requestJson = vi.hoisted(() => vi.fn());
vi.mock("#src/lib/post-json.ts", () => ({ requestJson }));

import { useQuestBuilder } from "#src/components/useQuestBuilder.ts";

type Builder = ReturnType<typeof useQuestBuilder>;

/** The hook's `send`, taken from a server render (no DOM here: state updates after the render are no-ops). */
function sendOf(): Builder["send"] {
  let send: Builder["send"] | undefined;
  const Probe = () => {
    send = useQuestBuilder("en", "org-1", "event-1").send;
    return null;
  };
  renderToString(createElement(Probe));
  if (send === undefined) throw new Error("the hook did not render");
  return send;
}

afterEach(() => requestJson.mockReset());

describe("useQuestBuilder send", () => {
  it("sends the create's idempotency key as a header, and none on a change without one", async () => {
    requestJson.mockResolvedValue({ ok: true, body: { focusQuestId: null, categories: [] } });
    const send = sendOf();

    await send("POST", "/quests", { title: "x" }, { key: "k-1" });
    expect(requestJson).toHaveBeenCalledWith(
      "POST",
      "/v1/organizers/org-1/events/event-1/quests",
      { title: "x" },
      { "idempotency-key": "k-1" },
    );

    requestJson.mockClear();
    await send("PATCH", "/quests/q-1", { title: "y" });
    expect(requestJson).toHaveBeenCalledWith(
      "PATCH",
      "/v1/organizers/org-1/events/event-1/quests/q-1",
      { title: "y" },
      {},
    );
  });
});
