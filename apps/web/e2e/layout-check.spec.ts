import { expect, test } from "@playwright/test";
import { contrastOf, readLayout } from "#e2e/layout.ts";

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
