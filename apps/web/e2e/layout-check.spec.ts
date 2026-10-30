import { expect, test } from "@playwright/test";
import {
  brokenImagesOf,
  contrastOf,
  navProblemsOf,
  readLayout,
  waitUntilSettled,
  watchRequests,
} from "#e2e/layout.ts";

/**
 * The layout check catches what it is for (ADR-364): a page built with each fault, as the staging dashboard had them,
 * is reported, and a clean one is not. Runs on a page of its own, so it needs no account.
 */
test("the layout check reports overflow, overlapping controls, small text and squeezed words", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.setContent(`
    <meta name="viewport" content="width=device-width" />
    <style>button { font: inherit; }</style>
    <body style="margin:0;font-size:16px;overflow-wrap:anywhere">
      <div style="inline-size:600px">Wider than the screen</div>
      <button style="position:absolute;inset-block-start:100px;inset-inline-start:10px">First</button>
      <button style="position:absolute;inset-block-start:105px;inset-inline-start:20px">Second</button>
      <p style="font-size:12px">Tiny print</p>
      <div style="display:flex"><span style="inline-size:20px">Ranking switches</span></div>
    </body>`);
  const problems = await readLayout(page);
  expect(problems.overflow).toBeGreaterThan(0);
  expect(problems.overlaps).toHaveLength(1);
  expect(problems.smallText).toEqual([`<p> "Tiny print" at 12px`]);
  expect(problems.brokenWords).toHaveLength(1);

  await page.setContent(`
    <meta name="viewport" content="width=device-width" />
    <style>button { font: inherit; }</style>
    <body style="margin:0;font-size:16px;overflow-wrap:anywhere">
      <p>Plain text that wraps across lines on a narrow screen without breaking any of its words apart.</p>
      <button>One</button> <button>Two</button>
      <p style="inline-size:120px">someone.with.a.long.address@example.test</p>
    </body>`);
  expect(await readLayout(page)).toEqual({
    overflow: 0,
    overlaps: [],
    textOverlaps: [],
    smallText: [],
    brokenWords: [],
    cramped: [],
    nestedBoxes: [],
  });
});

test("the layout check reports lines of text on top of each other and text under a control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.setContent(`
    <meta name="viewport" content="width=device-width" />
    <style>button { font: inherit; }</style>
    <body style="margin:0;font-size:16px;line-height:24px">
      <h1 style="margin:0;font-size:16px">A long page title</h1>
      <span style="position:absolute;inset-block-start:2px;inset-inline-start:20px">A badge on the title</span>
      <button style="position:absolute;inset-block-start:100px;inset-inline-start:10px;padding:40px 20px">Save</button>
      <span style="position:absolute;inset-block-start:100px;inset-inline-start:10px">Caption</span>
    </body>`);
  const problems = await readLayout(page);
  expect(problems.textOverlaps).toHaveLength(2);
  expect(problems.textOverlaps[0]).toContain("A badge on the title");
  expect(problems.textOverlaps[1]).toContain("Caption");
  expect(problems.textOverlaps[1]).toContain("under <button>");

  await page.setContent(`
    <meta name="viewport" content="width=device-width" />
    <body style="margin:0;font-size:16px;line-height:1.3">
      <h1 style="margin:0;inline-size:120px">A title long enough to wrap onto three lines here</h1>
      <p>Some <strong>bold</strong> words <a href="#x">in a link</a> and more text after them.</p>
    </body>`);
  expect((await readLayout(page)).textOverlaps).toEqual([]);
});

test("the layout check reports a box inside a box and text crammed into a narrow column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const box = "border:1px solid #888;background:#eee;padding:8px;margin:8px";
  await page.setContent(`
    <meta name="viewport" content="width=device-width" />
    <body style="margin:0;font-size:16px;overflow-wrap:anywhere">
      <section style="${box}"><article style="${box}">Inside a card</article></section>
      <p style="${box};border-inline-start-width:4px">A notice may sit in a card or on its own.</p>
      <div style="inline-size:100px">Words crammed into a column that is far too narrow</div>
      <a href="#x" style="display:inline-block;inline-size:70px">Open this page</a>
    </body>`);
  const problems = await readLayout(page);
  expect(problems.nestedBoxes).toHaveLength(1);
  expect(problems.nestedBoxes[0]).toContain("<article>");
  expect(problems.cramped.join(" ")).toContain("squeezed into 100px");
  expect(problems.cramped.join(" ")).toContain("wraps word by word");
});

test("the layout check reports text without enough contrast, also in a hovered state", async ({
  page,
}) => {
  await page.setContent(`
    <style>
      .bar { background: rgb(139, 90, 43); color: rgb(255, 253, 247); padding: 8px }
      .bar a { color: inherit }
      .bar a.bad:hover { background: rgb(255, 248, 230) }
      .faint { color: rgb(190, 190, 190) }
      .big { color: rgb(150, 150, 150); font-size: 28px }
      .veil { background: rgba(0, 0, 0, 0.2) }
    </style>
    <body style="margin:0;font-size:16px;background:white;color:black">
      <div class="bar"><a class="good veil" href="#a">Home</a> <a class="bad" href="#b">Account</a></div>
      <p class="faint">Pale grey text on white</p>
      <p class="big">Large grey text on white</p>
      <p>Black on white</p>
    </body>`);
  const failed = await page.evaluate(contrastOf, [4.5, 3] as const);
  expect(failed.filter((line) => line.includes("Pale grey"))).toHaveLength(1);
  expect(failed.filter((line) => line.includes("Large grey"))).toHaveLength(1);
  expect(failed.filter((line) => line.includes("Black on white"))).toHaveLength(0);
  expect(failed.filter((line) => line.includes("Home"))).toHaveLength(0);
  expect(failed.filter((line) => line.includes("Account"))).toHaveLength(0);

  await page.getByRole("link", { name: "Account" }).hover();
  const hovered = await page
    .getByRole("link", { name: "Account" })
    .evaluate(contrastOf, [4.5, 3] as const);
  expect(hovered).toHaveLength(1);
  expect(hovered[0]).toContain("Account");
});

test("the layout check leaves out what an inert region or an open modal dialog covers on purpose", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const covered = `
    <button style="position:absolute;inset-block-start:100px;inset-inline-start:10px">Under</button>
    <button style="position:absolute;inset-block-start:105px;inset-inline-start:20px">Sheet</button>`;
  await page.setContent(`<meta name="viewport" content="width=device-width" />
    <body style="margin:0;font-size:16px"><main inert>${covered}</main></body>`);
  expect((await readLayout(page)).overlaps).toEqual([]);

  await page.setContent(`<meta name="viewport" content="width=device-width" />
    <body style="margin:0;font-size:16px">${covered}
      <dialog><button>One</button> <button>Two</button></dialog></body>`);
  expect((await readLayout(page)).overlaps).toHaveLength(1);
  await page.evaluate(() => document.querySelector("dialog")?.showModal());
  expect((await readLayout(page)).overlaps).toEqual([]);
});

test("the layout check fails on text it cannot measure: over an image, or in a colour it cannot read", async ({
  page,
}) => {
  await page.setContent(`
    <body style="margin:0;font-size:16px;background:white;color:black">
      <p style="background-image:linear-gradient(white, rgb(230, 230, 230))">Text over a gradient</p>
      <p style="color:oklch(0.6 0.1 200)">Ink in a colour space the check does not read</p>
      <p>Plain black on white</p>
    </body>`);
  const failed = await page.evaluate(contrastOf, [4.5, 3] as const);
  expect(failed.filter((line) => line.includes("Text over a gradient"))).toHaveLength(1);
  expect(failed.find((line) => line.includes("Text over a gradient"))).toContain("over an image");
  expect(failed.filter((line) => line.includes("Ink in a colour space"))).toHaveLength(1);
  expect(failed.find((line) => line.includes("Ink in a colour space"))).toContain("cannot read");
  expect(failed.filter((line) => line.includes("Plain black"))).toHaveLength(0);
});

test("the layout check reports pictures that did not load, in a tag or in a style", async ({
  page,
}) => {
  const good =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  await page.setContent(`
    <body>
      <img src="${good}" alt="" width="20" height="20" />
      <div style="background-image:url(${good});inline-size:20px;block-size:20px"></div>
    </body>`);
  expect(await page.evaluate(brokenImagesOf)).toEqual([]);

  await page.setContent(`
    <body>
      <img src="${good}" alt="" width="20" height="20" />
      <img src="data:image/png;base64,AAAA" alt="" width="20" height="20" />
      <img alt="" width="20" height="20" />
      <img src="http://127.0.0.1:9/nothing.png" alt="" width="20" height="20" />
      <div style="background-image:url(data:image/png;base64,AAAA);inline-size:20px;block-size:20px"></div>
    </body>`);
  const broken = await page.evaluate(brokenImagesOf);
  expect(broken).toHaveLength(4);
  expect(broken.filter((line) => line.startsWith("<img>"))).toHaveLength(3);
  expect(broken.filter((line) => line.startsWith("a background image"))).toHaveLength(1);
});

/** A page with a navigation column of `count` links, the one at `current` marked as the open page. */
const navColumn = (style: string, count: number, current: number) => `
  <body style="margin:0;font-size:16px"><nav id="shell-navigation" style="${style}">${Array.from(
    { length: count },
    (_, index) =>
      `<a href="#p${index}" ${index === current ? 'aria-current="page"' : ""} style="display:block;block-size:30px">Page ${index}</a>`,
  ).join("")}</nav></body>`;

test("the layout check leaves out the rows a scrolling box has scrolled up and out of sight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const rows = Array.from(
    { length: 40 },
    (_, index) =>
      `<a href="#p${index}" style="display:block;block-size:30px;line-height:30px">Page ${index}</a>`,
  ).join("");
  await page.setContent(`<body style="margin:0;font-size:16px;line-height:20px">
    <header style="position:sticky;inset-block-start:0;block-size:60px"><button>Menu</button></header>
    <nav style="position:fixed;inset-block:60px 0;inset-inline-start:0;inline-size:200px;overflow-y:auto">${rows}</nav>
  </body>`);
  expect((await readLayout(page)).overlaps).toEqual([]);

  // Scrolled by 75px: two rows are wholly above the column, one half of the way under its top edge, beside the button.
  await page.locator("nav").evaluate((nav) => {
    nav.scrollTop = 75;
  });
  const scrolled = await readLayout(page);
  expect(scrolled.overlaps).toEqual([]);
  expect(scrolled.textOverlaps).toEqual([]);

  // A control that really covers another one inside the column is still reported.
  await page
    .locator("nav a")
    .nth(10)
    .evaluate((link) => {
      link.style.position = "relative";
      link.style.insetBlockStart = "20px";
    });
  expect((await readLayout(page)).overlaps).toHaveLength(1);
});

test("the layout check reports a navigation column that runs off the screen or hides the open page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const screenHigh = "position:sticky;inset-block-start:0;block-size:720px;overflow-y:auto";

  await page.setContent(navColumn("", 12, 3));
  expect(await page.evaluate(navProblemsOf)).toEqual([]);

  // Links that outgrow the screen scroll inside a column that is as tall as the screen: fine, but the open page must show.
  await page.setContent(navColumn(screenHigh, 40, 35));
  expect(await page.evaluate(navProblemsOf)).toEqual([
    "the open page's link (Page 35) is out of view",
  ]);
  expect(
    await page.locator("nav").evaluate((nav) => nav.scrollTop),
    "reading puts the scroll back",
  ).toBe(0);
  await page.getByRole("link", { name: "Page 35" }).evaluate((link) => link.scrollIntoView());
  expect(await page.evaluate(navProblemsOf)).toEqual([]);

  // A column that grows with its links pushes its last links off the screen for good.
  await page.setContent(navColumn("", 40, 3));
  const runsOff = await page.evaluate(navProblemsOf);
  expect(runsOff).toHaveLength(1);
  expect(runsOff[0]).toContain("below the screen");

  await page.setViewportSize({ width: 360, height: 780 });
  await page.setContent(navColumn("", 40, 35));
  expect(await page.evaluate(navProblemsOf)).toEqual([]);
});

test("the wait for a page to settle ends with its loading line, and fails on a page that never does", async ({
  page,
}) => {
  watchRequests(page);

  for (const words of ["Loading…", "جارٍ التحميل…"]) {
    await page.setContent(`
      <body><header><div role="status">${words}</div></header>
        <main><div role="status">${words}</div></main>
        <script>setTimeout(() => document.querySelector("main").replaceChildren("Ready"), 600)</script>
      </body>`);
    // The shell's own line outside the main area is not the page's, and the page's goes away by itself.
    await waitUntilSettled(page, "a page that loads");
    await expect(page.locator("main")).toHaveText("Ready");
  }

  await page.setContent(`<body><main><div role="status">Loading…</div></main></body>`);
  await expect(waitUntilSettled(page, "a page stuck loading")).rejects.toThrow(
    "a page stuck loading: still showing its loading state",
  );

  await page.route("http://never.test/**", () => new Promise<void>(() => {}));
  await page.setContent(
    `<body><main>Ready</main><script>fetch("http://never.test/slow")</script></body>`,
  );
  await expect(waitUntilSettled(page, "a page that never goes quiet")).rejects.toThrow(
    "1 requests still open",
  );
});
