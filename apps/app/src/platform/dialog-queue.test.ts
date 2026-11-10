import { describe, expect, it, vi } from "vitest";
import { createDialogQueue, type DialogRequest } from "#src/platform/dialog-queue.ts";
import { dialogPresses } from "#src/platform/dialog-presses.ts";

const request = (title: string): DialogRequest => ({ title, message: undefined, buttons: [] });

describe("the dialog queue", () => {
  it("refuses a dialog while no host is on screen, so the caller can use the browser's", () => {
    const queue = createDialogQueue();
    expect(queue.present(request("a"))).toBe(false);
    expect(queue.current()).toBeUndefined();
  });

  it("shows one dialog at a time, oldest first, and tells its listeners each change", () => {
    const queue = createDialogQueue();
    queue.mountHost();
    const changed = vi.fn();
    queue.subscribe(changed);
    expect(queue.present(request("first"))).toBe(true);
    expect(queue.present(request("second"))).toBe(true);
    expect(queue.current()?.title).toBe("first");
    queue.dismiss();
    expect(queue.current()?.title).toBe("second");
    queue.dismiss();
    expect(queue.current()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("stops taking dialogs when the last host unmounts, and stops telling an unsubscribed listener", () => {
    const queue = createDialogQueue();
    const unmount = queue.mountHost();
    const changed = vi.fn();
    const unsubscribe = queue.subscribe(changed);
    unsubscribe();
    expect(queue.present(request("a"))).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    unmount();
    expect(queue.present(request("b"))).toBe(false);
  });
});

describe("dialogPresses", () => {
  it("gives a dialog with no buttons one close button", () => {
    expect(dialogPresses([], "Close")).toEqual({
      buttons: [{ text: "Close" }],
      dismiss: undefined,
    });
  });

  it("dismisses with the cancel button and never with the action", () => {
    const cancel = { text: "Keep", style: "cancel" as const, onPress: vi.fn() };
    const action = { text: "Delete", style: "destructive" as const, onPress: vi.fn() };
    const shown = dialogPresses([action, cancel], "Close");
    expect(shown.buttons).toEqual([action, cancel]);
    expect(shown.dismiss).toBe(cancel);
    expect(dialogPresses([action], "Close").dismiss).toBeUndefined();
  });
});
