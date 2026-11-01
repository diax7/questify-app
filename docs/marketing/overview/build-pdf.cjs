// Prints index.html to ../Questify-overview.pdf with the Playwright install from apps/web.
// Run from the repo root: node docs/marketing/overview/build-pdf.cjs
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require(path.resolve(__dirname, "../../../apps/web/node_modules/@playwright/test"));

const page = path.join(__dirname, "index.html");
const out = path.join(__dirname, "..", "Questify-overview.pdf");

(async () => {
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const problems = [];
    tab.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    tab.on("requestfailed", (r) => problems.push(`missing file: ${r.url()}`));
    await tab.goto(pathToFileURL(page).href);
    await tab.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
    await tab.waitForLoadState("networkidle");
    if (problems.length) throw new Error(`overview page did not render cleanly:\n${problems.join("\n")}`);
    await tab.pdf({ path: out, width: "297mm", height: "210mm", printBackground: true, preferCSSPageSize: true });
    console.log(`wrote ${out}`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
