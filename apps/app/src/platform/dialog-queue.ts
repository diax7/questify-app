import type { AlertButton } from "#src/platform/web-alert.ts";

/** One question or message for the in-app dialog (T-803): the same title, message and buttons `Alert.alert` takes. */
export type DialogRequest = Readonly<{
  title: string;
  message: string | undefined;
  buttons: readonly AlertButton[];
}>;

type Listener = () => void;

/**
 * The dialogs waiting to be shown in the browser, one at a time. A browser may block `window.confirm` (an embedded
 * view, a page asked too often), and then a destructive action would cancel without a word, so the web build draws its
 * own dialog. The dialog's host component (`AlertHost.web.tsx`) mounts once and reads this; with no host mounted
 * (before the first screen, in a test) `present` says so and the caller falls back to the browser's own dialog.
 */
export function createDialogQueue() {
  const waiting: DialogRequest[] = [];
  const listeners = new Set<Listener>();
  let hosts = 0;
  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };
  return {
    /** A host is on screen; the returned function is its unmount. */
    mountHost(): () => void {
      hosts += 1;
      return () => {
        hosts -= 1;
      };
    },
    /** Queues the dialog and answers true, or answers false when no host would ever show it. */
    present(request: DialogRequest): boolean {
      if (hosts === 0) {
        return false;
      }
      waiting.push(request);
      notify();
      return true;
    },
    /** The dialog on screen now (the oldest waiting), or undefined. */
    current: (): DialogRequest | undefined => waiting[0],
    /** Takes the dialog on screen away (a button ran, or the shade or the back key was pressed) and shows the next. */
    dismiss(): void {
      waiting.shift();
      notify();
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const dialogs = createDialogQueue();
