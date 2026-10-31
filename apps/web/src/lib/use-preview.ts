"use client";
import { useEffect, useState } from "react";
import type { EventView } from "#src/lib/events.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import type { CategoryView } from "#src/lib/quests.ts";
import type { RewardView } from "#src/lib/rewards.ts";

export type PreviewSource = Readonly<{
  event: EventView;
  categories: readonly CategoryView[];
  rewards: readonly RewardView[];
}>;

export type PreviewRead =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "ready"; source: PreviewSource }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One field of an answer's body, or undefined when the read failed or the body is not an object. */
function fieldOf(result: PostResult, key: string): unknown {
  return result.ok && isRecord(result.body) ? result.body[key] : undefined;
}

/** The three reads as one source, or undefined when any of them failed or came back in another shape. */
function sourceOf(
  event: PostResult,
  quests: PostResult,
  rewards: PostResult,
): PreviewSource | undefined {
  const eventBody = fieldOf(event, "event");
  const categories = fieldOf(quests, "categories");
  const rewardList = fieldOf(rewards, "rewards");
  if (!isRecord(eventBody) || !Array.isArray(categories) || !Array.isArray(rewardList)) {
    return undefined;
  }
  return {
    event: eventBody as unknown as EventView,
    categories: categories as CategoryView[],
    rewards: rewardList as RewardView[],
  };
}

/**
 * What the preview draws from: the event, its quests and its rewards, read with the team's own reads. Nothing is written,
 * so opening the preview creates no player, points or completion (FR-1022).
 */
export function usePreview(organizerId: string, eventId: string): PreviewRead {
  const [read, setRead] = useState<PreviewRead>({ state: "loading" });
  useEffect(() => {
    let current = true;
    const api = `/v1/organizers/${organizerId}/events/${eventId}`;
    void Promise.all([
      requestJson("GET", api),
      requestJson("GET", `${api}/quests`),
      requestJson("GET", `${api}/rewards`),
    ]).then(([event, quests, rewards]) => {
      if (current) {
        const source = sourceOf(event, quests, rewards);
        setRead(source === undefined ? { state: "failed" } : { state: "ready", source });
      }
    });
    return () => {
      current = false;
    };
  }, [organizerId, eventId]);
  return read;
}
