import type { OwnDaily } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { usePlayer } from "#src/auth/player.tsx";
import { fetchOwnDaily } from "#src/daily/daily-api.ts";
import type { LevelUp } from "#src/questify/level.ts";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";

export type DailyRead = Readonly<{
  daily: OwnDaily | null;
  /** The latest read failed: say so with a retry, never show it as "no games". */
  failed: boolean;
  /** Reads again; resolves when the answer has been taken in. */
  load: () => Promise<void>;
  /** Writes a move's reply into the games held, and drops any read that began before it. */
  update: (change: (current: OwnDaily) => OwnDaily) => void;
}>;

/** The player's two games, read on every focus. An answer that arrives after a newer read or a move is dropped. */
export function useOwnDaily(): DailyRead {
  const [daily, setDaily] = useState<OwnDaily | null>(null);
  const [failed, setFailed] = useState(false);
  const newest = useRef(0);
  const load = useCallback(async () => {
    newest.current += 1;
    const mine = newest.current;
    const next = await fetchOwnDaily(api.session);
    if (mine !== newest.current) return;
    setFailed(next === null);
    if (next !== null) setDaily(next);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const update = useCallback((change: (current: OwnDaily) => OwnDaily) => {
    newest.current += 1;
    setDaily((current) => (current === null ? current : change(current)));
  }, []);
  return { daily, failed, load, update };
}

/**
 * What a finishing move sets going: the level-up card when it reached a level, the profile read again (XP, level,
 * streak) and a sync, which pays the gems of a level crossed and any streak milestone (ADR-309).
 */
export function useAfterFinish(): (reply: Readonly<{ levelUp: LevelUp | null }>) => void {
  const { reload } = usePlayer();
  const { syncNow, celebrate } = useQuestifySync();
  return useCallback(
    (reply) => {
      if (reply.levelUp !== null) celebrate(reply.levelUp);
      void reload();
      syncNow();
    },
    [reload, syncNow, celebrate],
  );
}
