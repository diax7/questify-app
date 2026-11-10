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
});
