import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api } from "#src/api/app-session.ts";
import { NOTHING_LIVE, fetchLive, type LiveState } from "#src/event/polls.ts";

/**
 * What is live in the event (ADR-221): read every `seconds` while the app is active, once more on each return to it,
 * never in the background. The ETag makes an unchanged answer a 304; a failed read keeps the last state and is tried
 * again at the next interval, silently.
 */
export function useLiveState(eventId: string, seconds: number): LiveState {
  const [state, setState] = useState<LiveState>(NOTHING_LIVE);
  const etag = useRef<string | null>(null);
  useEffect(() => {
    etag.current = null;
    setState(NOTHING_LIVE);
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const read = async () => {
      const answer = await fetchLive(api.session, eventId, etag.current);
      if (!stopped && answer.kind === "state") {
        etag.current = answer.etag;
        setState(answer.state);
      }
    };
    const start = () => {
      if (timer === undefined) {
        void read();
        timer = setInterval(() => void read(), seconds * 1000);
      }
    };
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    if (AppState.currentState === "active") {
      start();
    }
    const subscription = AppState.addEventListener("change", (next) =>
      next === "active" ? start() : stop(),
    );
    return () => {
      stopped = true;
      stop();
      subscription.remove();
    };
  }, [eventId, seconds]);
  return state;
}
