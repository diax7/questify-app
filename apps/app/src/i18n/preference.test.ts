import { describe, expect, it } from "vitest";
import {
  LANGUAGE_KEY,
  RESTART_KEY,
  loadRestartNote,
  loadStoredLanguage,
  saveLanguage,
  saveRestartNote,
} from "#src/i18n/preference.ts";

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe("language preference", () => {
  it("keeps the saved choice under a fixed name, so an update does not forget it", () => {
    expect(LANGUAGE_KEY).toBe("questify.language");
  });

  it("saves a choice under one key and reads it back", async () => {
    const storage = memory();
    await saveLanguage(storage, "ar");
    expect(storage.data.get(LANGUAGE_KEY)).toBe("ar");
    expect(await loadStoredLanguage(storage)).toBe("ar");
  });

  it("reads nothing when no choice was saved", async () => {
    expect(await loadStoredLanguage(memory())).toBeNull();
  });

  it("returns what is stored as it is, even if it is not a language", async () => {
    const storage = memory();
    storage.data.set(LANGUAGE_KEY, "klingon");
    expect(await loadStoredLanguage(storage)).toBe("klingon");
  });

  it("treats a store that cannot be read as no choice", async () => {
    const broken = {
      getItem: async () => {
        throw new Error("disk unavailable");
      },
      setItem: async () => undefined,
    };
    expect(await loadStoredLanguage(broken)).toBeNull();
  });

  it("does not hide a failure to save", async () => {
    const broken = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("disk full");
      },
    };
    await expect(saveLanguage(broken, "en")).rejects.toThrow("disk full");
  });
});

describe("restart note", () => {
  it("keeps the note under its own fixed name and reads it back", async () => {
    const storage = memory();
    expect(RESTART_KEY).toBe("questify.restartTriedFor");
    await saveRestartNote(storage, "ar");
    expect(storage.data.get(RESTART_KEY)).toBe("ar");
    expect(await loadRestartNote(storage)).toBe("ar");
    await saveRestartNote(storage, "");
    expect(await loadRestartNote(storage)).toBe("");
  });

  it("reads none when there is none or the store cannot be read", async () => {
    expect(await loadRestartNote(memory())).toBeNull();
    const broken = {
      getItem: async () => {
        throw new Error("disk unavailable");
      },
      setItem: async () => undefined,
    };
    expect(await loadRestartNote(broken)).toBeNull();
  });
});
