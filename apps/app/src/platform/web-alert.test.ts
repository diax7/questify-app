import { describe, expect, it, vi } from "vitest";
import { webAlert } from "#src/platform/web-alert.ts";

const env = (answer: boolean) => ({ alert: vi.fn(), confirm: vi.fn(() => answer) });

describe("webAlert", () => {
  it("asks with title and message and runs the action on OK", () => {
    const e = env(true);
    const cancel = vi.fn();
    const action = vi.fn();
    webAlert(
      "Sign out",
      "You will need a new code.",
      [
        { text: "Cancel", style: "cancel", onPress: cancel },
        { text: "Sign out", style: "destructive", onPress: action },
      ],
      e,
    );
    expect(e.confirm).toHaveBeenCalledExactlyOnceWith("Sign out\n\nYou will need a new code.");
    expect(action).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(e.alert).not.toHaveBeenCalled();
  });

  it("runs the cancel button's own handler on Cancel, and not the action", () => {
    const e = env(false);
    const cancel = vi.fn();
    const action = vi.fn();
    webAlert(
      "Leave the game?",
      undefined,
      [
        { text: "Keep playing", style: "cancel", onPress: cancel },
        { text: "Leave", onPress: action },
      ],
      e,
    );
    expect(e.confirm).toHaveBeenCalledExactlyOnceWith("Leave the game?");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it("finds the cancel button wherever it stands and takes the first other button as the action", () => {
    const e = env(true);
    const action = vi.fn();
    webAlert(
      "Block",
      "",
      [
        { text: "Block", style: "destructive", onPress: action },
        { text: "Cancel", style: "cancel" },
      ],
      e,
    );
    expect(e.confirm).toHaveBeenCalledExactlyOnceWith("Block");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("shows a plain message with window.alert, and runs the one button after it", () => {
    const e = env(true);
    const ok = vi.fn();
    webAlert("Saved", "Your changes are in.", [{ text: "OK", onPress: ok }], e);
    expect(e.alert).toHaveBeenCalledExactlyOnceWith("Saved\n\nYour changes are in.");
    expect(e.confirm).not.toHaveBeenCalled();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("shows a message with no buttons with window.alert", () => {
    const e = env(true);
    webAlert("The link could not be opened.", undefined, undefined, e);
    expect(e.alert).toHaveBeenCalledExactlyOnceWith("The link could not be opened.");
    expect(e.confirm).not.toHaveBeenCalled();
  });

  it("does nothing when the browser has neither dialog", () => {
    const action = vi.fn();
    webAlert(
      "Title",
      undefined,
      [
        { text: "No", style: "cancel" },
        { text: "Yes", onPress: action },
      ],
      {},
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("still asks when two buttons have no cancel style, and runs nothing on Cancel", () => {
    const e = env(false);
    const first = vi.fn();
    const second = vi.fn();
    webAlert(
      "Delete the photo?",
      undefined,
      [
        { text: "Delete", onPress: first },
        { text: "Keep", onPress: second },
      ],
      e,
    );
    expect(e.confirm).toHaveBeenCalledExactlyOnceWith("Delete the photo?");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(e.alert).not.toHaveBeenCalled();
  });
});

describe("webAlert with the app's own dialog", () => {
  it("hands every button to the dialog and leaves the browser's dialogs alone", () => {
    const e = env(true);
    const present = vi.fn(() => true);
    const onPress = vi.fn();
    const buttons = [
      { text: "Cancel", style: "cancel" as const },
      { text: "Delete", style: "destructive" as const, onPress },
    ];
    webAlert("Delete?", "It cannot be undone.", buttons, e, { present });
    expect(present).toHaveBeenCalledExactlyOnceWith({
      title: "Delete?",
      message: "It cannot be undone.",
      buttons,
    });
    expect(e.confirm).not.toHaveBeenCalled();
    expect(e.alert).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("falls back to the browser's dialog when no dialog host is on screen", () => {
    const e = env(true);
    const action = vi.fn();
    webAlert(
      "Delete?",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", onPress: action },
      ],
      e,
      { present: () => false },
    );
    expect(e.confirm).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
