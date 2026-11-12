import type { Pool } from "pg";
import { inDevice } from "#src/devices/errors";
import { signedScene } from "#src/screen/photo-wall";
import type { ObjectStore } from "#src/storage/client";

/** The scenes the team picks and orders (FR-631); the photo wall is T-504b (migration 0195). */
export const SCENES = ["ranking", "community", "poll", "photo"] as const;
export type Scene = (typeof SCENES)[number];
/**
 * What a screen can read: the picked scenes, the finale a set finale adds by itself (T-307b) and the Cheers scene a live
 * cheers moment runs alone (T-509).
 */
export const SCREEN_SCENES = [...SCENES, "finale", "cheers"] as const;
export type ScreenScene = (typeof SCREEN_SCENES)[number];

const FUNCTIONS: Readonly<Record<ScreenScene, string>> = {
  ranking: "screen_ranking",
  community: "screen_community",
  poll: "screen_poll",
  photo: "screen_photos",
  finale: "screen_finale",
  cheers: "screen_cheers",
};

/** A scene as the database answers it: `shut` says why nothing shows, else the scene's own fields. */
export type SceneAnswer = Readonly<Record<string, unknown>>;

/** How long one event's answer for one scene is shared among its screens. */
export const SCENE_CACHE_MS = 2000;
/** Past this many entries the map is emptied rather than grown (one instance's events in a few seconds). */
const MAP_CAP = 5000;

export type SceneReader = Readonly<{
  /** The scene for the event of a living, activated big screen (the caller's guard has checked it). */
  read: (
    device: Readonly<{ id: string; eventId: string }>,
    scene: ScreenScene,
  ) => Promise<SceneAnswer>;
}>;

type Kept = Readonly<{ until: number; answer: Promise<SceneAnswer> }>;

/**
 * Reads a scene through the screen's own door (`screen_ranking`, `screen_community`, `screen_poll`, `screen_finale`, `screen_cheers`: each takes no
 * argument and reads only the calling device's event). Every screen of an event shows the same scene, so one answer per
 * event and scene is kept for 2 seconds and shared, concurrent callers included: the database sees at most one read
 * per event, scene and 2 seconds however many screens poll (the poll counts are an aggregate, never one per request,
 * T-306 note). A failed read is forgotten at once. The guard has already refused a revoked or foreign device, so the
 * cache never answers one.
 */
export function createSceneReader(
  deps: Readonly<{ pool: Pool; storage?: ObjectStore | undefined }>,
  now: () => number = Date.now,
): SceneReader {
  const kept = new Map<string, Kept>();
  return {
    read: (device, scene) => {
      const key = `${device.eventId}:${scene}`;
      const found = kept.get(key);
      if (found !== undefined && found.until > now()) {
        return found.answer;
      }
      if (kept.size >= MAP_CAP) {
        kept.clear();
      }
      const answer = inDevice(deps.pool, { deviceId: device.id }, async (client) => {
        const { rows } = await client.query<{ answer: SceneAnswer }>(
          `SELECT ${FUNCTIONS[scene]}() AS answer`,
        );
        const read = (rows[0] as { answer: SceneAnswer }).answer;
        // The photo scene's keys never leave the API: each is signed for 120 s from the minute's start (M2).
        return scene === "photo" ? signedScene(deps.storage, read, now) : read;
      });
      kept.set(key, { until: now() + SCENE_CACHE_MS, answer });
      answer.catch(() => {
        if (kept.get(key)?.answer === answer) {
          kept.delete(key);
        }
      });
      return answer;
    },
  };
}
