import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    // Sign-in tests do real password hashing many times; a 2-core CI runner needs more than the default 5 s.
    testTimeout: 30_000,
    // Each integration file creates its own database and runs every migration in `beforeAll`; with the whole suite in
    // parallel that takes longer than the default 10 s, and more with each migration.
    hookTimeout: 60_000,
  },
});
