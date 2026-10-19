import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("uses safe defaults for local work", () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: "development",
      host: "0.0.0.0",
      port: 3000,
      minAppVersion: "1.0.0",
      releaseSha: "dev",
    });
  });

  it("reads every setting from the environment", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "8080",
        MIN_APP_VERSION: "1.4.2",
        RELEASE_SHA: "abc1234",
      }),
    ).toEqual({
      nodeEnv: "production",
      host: "127.0.0.1",
      port: 8080,
      minAppVersion: "1.4.2",
      releaseSha: "abc1234",
    });
  });

  it.each(["0", "65536", "-1", "abc", "30.5", ""])("rejects the port %j", (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });

  it.each(["banana", "1", ""])("rejects the minimum app version %j", (version) => {
    expect(() => loadConfig({ MIN_APP_VERSION: version })).toThrow(/MIN_APP_VERSION/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
