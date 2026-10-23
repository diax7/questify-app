import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * The test run Stryker uses (stryker.config.json, `vitest.configFile`): the normal suite without the many-seed
 * calibration files (`*.calibration.test.ts`), which `pnpm test` and CI still run. Under Stryker's instrumentation a
 * 5,000-seed loop outlasts the 30 s test timeout and fails the initial run (mutation run 40030086932).
 */
export default mergeConfig(base, defineConfig({ test: { exclude: ["**/*.calibration.test.ts"] } }));
