import type { NotificationItem } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { appendRows, mergeFirstPage, withRead, type CenterList } from "#src/push/center.ts";
import { fetchCenterPage, markNotificationsRead } from "#src/push/push-api.ts";
import { setUnread, setUnreadIfRead } from "#src/push/unread-store.ts";

export type Center = Readonly<{
  /** The rows read so far, newest first; null until the first page arrives. */
  rows: readonly NotificationItem[] | null;
  /** The latest read failed: say so with a retry, never show it as an empty center. */
  failed: boolean;
  /** Null when the last page has been read. */
  more: (() => void) | null;
  retry: () => void;
  /** Shows the named rows (all with `null`) as read at once and tells the server. */
  markRead: (ids: readonly number[] | null) => void;
}>;

/**
 * The notification center's rows (FR-1824): the newest page each time the screen gains focus (older pages already loaded
 * stay), older pages on request. Every answer refreshes the bell's count. An answer that arrives after a newer read began
 * is dropped.
 */
export function useCenter(): Center {
  const [list, setList] = useState<CenterList>({ rows: null, next: null });
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  const first = useCallback(async () => {
    const mine = ++generation.current;
    const page = await fetchCenterPage(api.session, null);
    if (mine !== generation.current) return;
    setFailed(page === null);
    if (page === null) return;
    setList((current) => mergeFirstPage(current, page));
    setUnread(page.unread);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void first();
    }, [first]),
  );

  const { next } = list;
  const more =
    next === null
      ? null
      : () => {
          const mine = generation.current;
          void fetchCenterPage(api.session, next).then((page) => {
            if (mine !== generation.current) return;
            setFailed(page === null);
            if (page === null) return;
            setList((current) => ({
              rows: appendRows(current.rows ?? [], page.items),
              next: page.nextBefore,
            }));
            setUnread(page.unread);
          });
        };

  const markRead = useCallback((ids: readonly number[] | null) => {
    setList((current) =>
      current.rows === null ? current : { ...current, rows: withRead(current.rows, ids) },
    );
    void markNotificationsRead(api.session, ids === null ? { all: true } : { ids: [...ids] }).then(
      setUnreadIfRead,
    );
  }, []);

  return { rows: list.rows, failed, more, retry: () => void first(), markRead };
}
