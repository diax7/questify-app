import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    // Sign-in tests do real password hashing many times; a 2-core CI runner needs more than the default 5 s.
    testTimeout: 30_000,
  },
});
