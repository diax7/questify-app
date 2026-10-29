import { expect, test } from "@playwright/test";
import { readLayout } from "#e2e/layout.ts";

/**
 * The layout check catches what it is for (ADR-364): a page built with each fault, as the staging dashboard had them,
 * is reported, and a clean one is not. Runs on a page of its own, so it needs no account.
 */
test("the layout check reports overflow, overlapping controls, small text and squeezed words", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
    smallText: [],
    brokenWords: [],
  });
});
