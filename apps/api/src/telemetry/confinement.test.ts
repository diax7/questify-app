import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = "apps/api/src";

/** Every server source file outside `telemetry/`, as a path under `apps/api/src` (tests excluded). */
function filesOutsideTelemetry(): string[] {
  return readdirSync(SOURCE, { recursive: true, encoding: "utf8" })
    .map((path) => path.replaceAll("\\", "/"))
    .filter(
      (path) =>
        path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.startsWith("telemetry/"),
    );
}

describe("where the telemetry attributes are given", () => {
  it("is only inside telemetry/: the closed attribute list is enforced nowhere else (ADR-603)", () => {
    const files = filesOutsideTelemetry();
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) =>
      /@opentelemetry\/|\bsetAttributes?\(|\bstartSpan\(|\bstartActiveSpan\(/.test(
        readFileSync(`${SOURCE}/${file}`, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
