import { expect, test } from "@playwright/test";

/**
 * The event web page (T-112): what the join QR and invite link open on a phone without the app. The e2e API seeds a
 * live public event NAJD1 ("Tech Fest") and a live private one TABUK1 ("Winter Fest"); no store links are set here.
 */
test("shows a live event by its code, with what the organizer sees and the link to copy", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const answer = await page.goto("/ar/e/najd1");
  expect(answer?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "Tech Fest" })).toBeVisible();
  await expect(page.getByText("الفعالية جارية الآن")).toBeVisible();
  await expect(page.getByText("NAJD1", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "سيرى منظّم الفعالية" })).toBeVisible();
  await expect(page.getByText("اسم المستخدم والصورة الرمزية")).toBeVisible();
  await expect(page.getByText("التطبيق قادم إلى المتاجر قريبًا.")).toBeVisible();
  await page.getByRole("button", { name: "انسخ رابط الفعالية" }).click();
  await expect(page.getByRole("status")).toContainText("نسخنا رابط الفعالية");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://questify.sa/ar/e/NAJD1",
  );

  await page.goto("/en/e/NAJD1");
  await expect(page.getByText("The event is on now")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the event link" })).toBeVisible();
});

test("writes a link preview and keeps private events out of search", async ({ page, request }) => {
  await page.goto("/en/e/NAJD1");
  const meta = (name: string) =>
    page.locator(`head meta[property="${name}"], head meta[name="${name}"]`);
  await expect(meta("og:title")).toHaveAttribute("content", "Tech Fest");
  await expect(meta("og:url")).toHaveAttribute("content", "https://questify.sa/en/e/NAJD1");
  await expect(meta("og:locale")).toHaveAttribute("content", "en_US");
  const image = await meta("og:image").getAttribute("content");
  expect(image).toMatch(/^https:\/\/questify\.sa\/.+opengraph-image/);
  // The image's path answers here too (the absolute URL names production).
  expect((await request.get(new URL(image ?? "").pathname)).status()).toBe(200);
  await expect(meta("robots")).toHaveAttribute("content", /^index/);

  await page.goto("/en/e/TABUK1");
  await expect(page.getByRole("heading", { level: 1, name: "Winter Fest" })).toBeVisible();
  await expect(meta("robots")).toHaveAttribute("content", /noindex/);
});

test("gives a link-preview bot the tags in the page's head, without JavaScript (FR-116)", async ({
  request,
}) => {
  const response = await request.get("/en/e/NAJD1", {
    headers: { "user-agent": "WhatsApp/2.23.20.0 A" },
  });
  const html = await response.text();
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain('<meta property="og:title" content="Tech Fest"/>');
  expect(head).toMatch(/<meta property="og:image" content="https:\/\/questify\.sa\/[^"]+"/);
});

test("says an unknown or malformed code is not available, in the language of the address", async ({
  page,
}) => {
  const shown = { ar: "هذه الفعالية غير متاحة.", en: "This event is not available." } as const;
  const cases = [
    ["/ar/e/NOPE99", "ar", "en"],
    ["/en/e/has-dash", "en", "ar"],
    ["/en/e/AB", "en", "ar"],
    ["/ar/e/AB", "ar", "en"],
  ] as const;
  for (const [path, language, other] of cases) {
    const answer = await page.goto(path);
    expect(answer?.status(), path).toBe(404);
    await expect(page.getByText(shown[language])).toBeVisible();
    await expect(page.getByText(shown[other])).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
  }
});
