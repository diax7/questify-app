import { expect, test, type Page } from "@playwright/test";
import { codeFor, freshAddress } from "#e2e/mail.ts";
import { CONTROL_PORT } from "#e2e/paths.ts";

const PASSWORD = "an organizer's own pass phrase";

/** Signs up as a new organizer's owner and lands on the home page. */
async function signUpOwner(page: Page, project: string): Promise<void> {
  // A page error (a hydration mismatch among them) fails the test.
  page.on("pageerror", (error) => {
    throw error;
  });
  const email = `events.${project}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@riyadh.test`;
  await freshAddress(page);
  await page.goto("/en/sign-up");
  await page.getByLabel("Organizer name", { exact: true }).fill("Najd Events Co");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Type the new password again", { exact: true }).fill(PASSWORD);
  await page.getByLabel("I accept the organizer terms").check();
  await page.getByLabel("I accept the data processing agreement").check();
  await page.getByLabel("I accept the content rules").check();
  await page.getByRole("button", { name: "Create the account" }).click();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(await codeFor(email));
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page).toHaveURL(/\/en$/);
}

test("an owner creates a draft, sees its times in its zone, edits it, and deletes it after confirming", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await signUpOwner(page, info.project.name);
  await page.getByRole("link", { name: "Events" }).click();
  await expect(page.getByText("No events yet. Create your first one.")).toBeVisible();
  await page.getByRole("link", { name: "New event" }).click();

  await page.getByLabel("Name in English", { exact: true }).fill("Najd Meetup");
  await page.getByRole("combobox", { name: /^Time zone/ }).selectOption("Asia/Dubai");
  await page.getByLabel("Starts", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();

  await expect(page.getByRole("heading", { name: "Najd Meetup" })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Starts", { exact: true })).toHaveValue("2030-11-01T09:00");

  await page.getByLabel("Name in English", { exact: true }).fill("Najd Summit");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();

  await page.getByRole("link", { name: "All events" }).click();
  await expect(page.getByText("Fri, 1 Nov 2030, 09:00 (Dubai time)")).toBeVisible();

  await page.getByRole("link", { name: "Najd Summit" }).click();
  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(
    page.getByText("“Najd Summit” and its settings will be deleted for good.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete draft" }).click();
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByText("No events yet. Create your first one.")).toBeVisible();
});

test("names a field the API refused, in Arabic, right to left", async ({ page }, info) => {
  await signUpOwner(page, info.project.name);
  await page.goto(page.url().replace("/en", "/ar"));
  await page.getByRole("link", { name: "الفعاليات" }).click();
  await page.getByRole("link", { name: "فعالية جديدة" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByLabel("الاسم بالعربية", { exact: true }).fill("ملتقى نجد");
  await page.getByLabel("تبدأ", { exact: true }).fill("2030-11-01T17:00");
  await page.getByLabel("تنتهي", { exact: true }).fill("2030-11-01T09:00");
  await page.getByRole("button", { name: "إنشاء الفعالية" }).click();
  await expect(page.getByText("اجعل وقت النهاية بعد وقت البداية.")).toBeVisible();
});

test("the owner hides the ranking and shows it again, in Arabic; it stays as saved after a reload", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await signUpOwner(page, info.project.name);
  await page.goto(page.url().replace("/en", "/ar"));
  await page.getByRole("link", { name: "الفعاليات" }).click();
  await page.getByRole("link", { name: "فعالية جديدة" }).click();
  await page.getByLabel("الاسم بالعربية", { exact: true }).fill("ملتقى الترتيب");
  await page.getByLabel("تبدأ", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("تنتهي", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "إنشاء الفعالية" }).click();

  const shown = page.getByRole("checkbox", { name: "إظهار الترتيب في التطبيق" });
  await expect(shown).toBeChecked();
  await shown.uncheck();
  await expect(shown).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "إظهار الترتيب في التطبيق" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "إظهار الترتيب في التطبيق" }).check();
  await expect(page.getByRole("checkbox", { name: "إظهار الترتيب في التطبيق" })).toBeChecked();

  const today = page.getByRole("checkbox", { name: "إظهار ترتيب اليوم" });
  await expect(today).toBeChecked();
  await today.uncheck();
  await expect(today).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "إظهار ترتيب اليوم" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "إظهار الترتيب في التطبيق" })).toBeChecked();
});

test("an owner picks the event's city, it clears for an online event and locks once the event is live", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await signUpOwner(page, info.project.name);
  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: "New event" }).click();
  await page.getByLabel("Name in English", { exact: true }).fill("Jeddah Meetup");
  await page.getByRole("combobox", { name: /^City/ }).selectOption({ label: "Jeddah" });
  await page.getByLabel("Starts", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { name: "Jeddah Meetup" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^City/ })).toHaveValue("sa-jeddah");

  await page.getByRole("combobox", { name: /^City/ }).selectOption({ label: "Riyadh" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: /^City/ })).toHaveValue("sa-riyadh");

  // An online event has no city: the field goes and the saved city is cleared.
  await page.getByRole("combobox", { name: "Kind of event" }).selectOption("virtual");
  await expect(page.getByRole("combobox", { name: /^City/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.getByRole("combobox", { name: "Kind of event" }).selectOption("physical");
  await expect(page.getByRole("combobox", { name: /^City/ })).toHaveValue("");

  // Once the event is live its city is fixed, said in Arabic too.
  await page.getByRole("combobox", { name: /^City/ }).selectOption({ label: "Abha" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  const eventId = page.url().split("/").at(-1) ?? "";
  const control = `http://127.0.0.1:${CONTROL_PORT}`;
  expect(
    (
      await page.request.post(`${control}/event-status`, { data: { eventId, status: "live" } })
    ).status(),
  ).toBe(204);
  await page.goto(page.url().replace("/en/", "/ar/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const city = page.getByRole("combobox", { name: /^المدينة/ });
  await expect(city).toHaveValue("sa-abha");
  await expect(city).toBeDisabled();
  await expect(page.getByText("بدأت الفعالية، فلا تتغير مدينتها.")).toBeVisible();
});

test("an owner ticks up to three interests, the fourth is blocked, and they persist in both languages", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await signUpOwner(page, info.project.name);
  await page.getByRole("link", { name: "Events" }).click();
  await page.getByRole("link", { name: "New event" }).click();
  await page.getByLabel("Name in English", { exact: true }).fill("Sport Night");
  await page.getByRole("checkbox", { name: "Sport" }).check();
  await page.getByRole("checkbox", { name: "Music" }).check();
  await page.getByRole("checkbox", { name: "Technology" }).check();
  await expect(page.getByRole("checkbox", { name: "Gaming" })).toBeDisabled();
  await expect(
    page.getByText("You chose three interests. Remove one to choose another."),
  ).toBeVisible();
  await page.getByLabel("Starts", { exact: true }).fill("2030-11-01T09:00");
  await page.getByLabel("Ends", { exact: true }).fill("2030-11-01T17:00");
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { name: "Sport Night" })).toBeVisible();
  for (const name of ["Sport", "Music", "Technology"]) {
    await expect(page.getByRole("checkbox", { name })).toBeChecked();
  }

  await page.getByRole("checkbox", { name: "Music" }).uncheck();
  await page.getByRole("checkbox", { name: "Gaming" }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Music" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Gaming" })).toBeChecked();

  await page.goto(page.url().replace("/en/", "/ar/"));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("group", { name: "الاهتمامات" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "رياضة", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "ألعاب", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "موسيقى", exact: true })).toBeDisabled();
});
