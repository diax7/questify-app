import {
  REGISTRIES,
  isOrganizerOverridable,
  reviewDemoRawSchema,
  reviewDemoView,
  type ReviewDemoPrepared,
  type ReviewDemoView,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import {
  invalidReviewDemo,
  notFound,
  reviewDemoContactHeld,
  reviewDemoExists,
  reviewDemoStale,
} from "#src/auth/http-errors";
import { generateCode, type AuthKeys } from "#src/auth/keys";
import { door, type Admin } from "#src/console/doors";
import { answerOf } from "#src/console/platform";
import type { HttpError } from "#src/http-error";

export type ReviewDemoKeys = Pick<
  AuthKeys,
  "contactLookupKey" | "deletionFingerprint" | "reviewerCodeHash"
>;

/** The features Questify can switch on for one organizer: the demo organizer gets each On (ADR-560). */
export const overridableFeatures = (): string[] =>
  Object.entries(REGISTRIES.features)
    .filter(([, definition]) => isOrganizerOverridable(definition))
    .map(([key]) => key)
    .toSorted();

/**
 * The review demo doors' own refusals (migration 0144) by SQLSTATE and DETAIL; an admin check (QE403) and anything else
 * go to the console's shared door.
 */
function refusalOf(error: unknown): HttpError | undefined {
  const { code, detail } = error as { code?: unknown; detail?: unknown };
  if (code === "RD404") {
    return notFound();
  }
  if (code === "RD400") {
    return invalidReviewDemo({ field: String(detail) });
  }
  if (code === "RD409") {
    const byDetail: Readonly<Record<string, () => HttpError>> = {
      review_demo_exists: reviewDemoExists,
      contact_held: reviewDemoContactHeld,
    };
    return (byDetail[String(detail)] ?? reviewDemoStale)();
  }
  // Prepare met a deletion of the reviewer in flight (erase_target's NOWAIT): the admin tries again.
  return code === "55P03" ? reviewDemoStale() : undefined;
}

function reviewDoor<T>(pool: Pool, admin: Admin, work: (client: PoolClient) => Promise<T>) {
  return door(pool, admin, work).catch((error: unknown) => {
    throw refusalOf(error) ?? error;
  });
}

async function viewOf(client: PoolClient, sql: string, values: unknown[]): Promise<ReviewDemoView> {
  return reviewDemoView(reviewDemoRawSchema.parse(await answerOf(client, sql, values)));
}

/** The console page's state and readiness checklist (T-710, ADR-568). Read only; not audited. */
export function readReviewDemo(pool: Pool, admin: Admin): Promise<ReviewDemoView> {
  return reviewDoor(pool, admin, (client) =>
    viewOf(client, "SELECT console_review_demo() AS r", []),
  );
}

type Change = Readonly<{ requestId: string }>;

/** The reviewer phone's lookup key and fingerprint, as a challenge stores them. */
const keysOf = (keys: ReviewDemoKeys, phone: string) => [
  keys.contactLookupKey(phone),
  keys.deletionFingerprint(phone),
];

/** Create, once (ADR-560): the demo organizer, its live event, the fictional players and the reviewer account. */
export function createReviewDemo(
  pool: Pool,
  keys: ReviewDemoKeys,
  admin: Admin,
  input: Change & Readonly<{ phone: string }>,
): Promise<ReviewDemoView> {
  return reviewDoor(pool, admin, (client) =>
    viewOf(client, "SELECT console_review_demo_create($1, $2, $3, $4, $5) AS r", [
      input.phone,
      ...keysOf(keys, input.phone),
      overridableFeatures(),
      input.requestId,
    ]),
  );
}

/** Change reviewer number: closes the window and ends the reviewer's sessions (ADR-562). */
export function setReviewDemoContact(
  pool: Pool,
  keys: ReviewDemoKeys,
  admin: Admin,
  input: Change & Readonly<{ phone: string }>,
): Promise<ReviewDemoView> {
  return reviewDoor(pool, admin, (client) =>
    viewOf(client, "SELECT console_review_demo_set_contact($1, $2, $3, $4) AS r", [
      input.phone,
      ...keysOf(keys, input.phone),
      input.requestId,
    ]),
  );
}

/**
 * Prepare for review (ADR-564): a new six-digit code, shown once here and stored only as its hash. The reviewer phone is
 * read in the same seat and its key and fingerprint computed again, so a rotated auth secret is caught up.
 */
export function prepareReviewDemo(
  pool: Pool,
  keys: ReviewDemoKeys,
  admin: Admin,
  input: Change & Readonly<{ days: number; version: string }>,
): Promise<ReviewDemoPrepared> {
  return reviewDoor(pool, admin, async (client) => {
    const current = reviewDemoRawSchema.parse(
      await answerOf(client, "SELECT console_review_demo() AS r"),
    );
    if (!current.exists) {
      throw notFound();
    }
    const code = generateCode();
    const demo = await viewOf(
      client,
      "SELECT console_review_demo_prepare($1, $2, $3, $4, $5, $6, $7) AS r",
      [
        current.contact,
        ...keysOf(keys, current.contact),
        keys.reviewerCodeHash(code),
        input.days,
        input.version,
        input.requestId,
      ],
    );
    // Stryker disable next-line ConditionalExpression,StringLiteral: unreachable: a prepared demo always has a window
    const windowUntil = demo.exists ? (demo.windowUntil ?? "") : "";
    return { code, windowUntil, demo };
  });
}

/** Close window: the fixed code stops and the reviewer's sessions end at once. */
export function closeReviewDemo(pool: Pool, admin: Admin, input: Change): Promise<ReviewDemoView> {
  return reviewDoor(pool, admin, (client) =>
    viewOf(client, "SELECT console_review_demo_close($1) AS r", [input.requestId]),
  );
}
