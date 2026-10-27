import type { OwnDaily } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * What a finishing move sets going: the profile read again (XP, level, streak) and a sync, which pays the gems of a
 * level crossed and any streak milestone (ADR-309). The level-up card waits for `useCelebrateWhen`.
 */
export function useAfterFinish(): () => void {
  const { reload } = usePlayer();
  const { syncNow } = useQuestifySync();
  return useCallback(() => {
    void reload();
    syncNow();
  }, [reload, syncNow]);
}

/**
 * Shows the level-up card for a level a finish reached, but only once `ready` (the last reveal or marks have been seen:
 * the player moved on, or the result card is up) and after `delayMs`. Leaving the screen first shows it at once, so a
 * level reached is never lost.
 */
export function useCelebrateWhen(levelUp: LevelUp | null, ready: boolean, delayMs: number): void {
  const { celebrate } = useQuestifySync();
  const pending = useRef<LevelUp | null>(null);
  useEffect(() => {
    pending.current = levelUp;
  }, [levelUp]);
  const show = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (next !== null) celebrate(next);
  }, [celebrate]);
  useEffect(() => {
    if (levelUp === null || !ready) return;
    const timer = setTimeout(show, delayMs);
    return () => clearTimeout(timer);
  }, [levelUp, ready, delayMs, show]);
  // Leaving the screen first shows what is still pending.
  useEffect(() => show, [show]);
}
