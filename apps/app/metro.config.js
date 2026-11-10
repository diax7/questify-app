const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

/**
 * The app imports its own files with their extension (`#src/push/push-native.ts`, rules.md), and Metro picks a
 * `.web.ts` sibling only for an import without one. So on the web, an `#src/...ts` or `#src/...tsx` import takes its
 * `name.web.ts` (or `.web.tsx`) when the file exists: that is how the web build gets its no-op haptics, push and NFC and
 * never bundles the native modules behind them (T-803). A phone build is untouched.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName.startsWith("#src/")) {
    const match = /^(.*)\.(tsx?)$/.exec(moduleName.slice("#src/".length));
    if (match !== null && !match[1].endsWith(".web")) {
      const filePath = join(__dirname, "src", `${match[1]}.web.${match[2]}`);
      if (existsSync(filePath)) {
        return { type: "sourceFile", filePath };
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
