/** The API's staff session cookie (apps/api/src/auth/session.ts). */
export const SESSION_COOKIE = "__Host-qs_session";

export type Membership = Readonly<{
  organizerId: string;
  organizerName: string;
  role: "owner" | "editor";
  /** The events an editor is limited to, or null for all of the organizer's events. */
  eventScope: readonly string[] | null;
  /** Questify paused this organizer, with the reason it wrote (T-701, Q-372); null otherwise. */
  suspension: Suspension | null;
  /** The organizer documents in force that the owner has not accepted: writes are refused until then (T-707). */
  legalPending: readonly LegalPending[];
  /** Set only for a Questify admin's support grants (ADR-407): the events and when each ends. */
  support?: readonly Readonly<{
    grantId: string;
    eventId: string;
    expiresAt: string;
    /** `view` is read-only (T-712); anything unknown is read as a view, so the banner never claims more. */
    kind: "view" | "edit";
  }>[];
}>;

export type Suspension = Readonly<{ reason: string; since: string }>;

export type LegalPending = Readonly<{
  document: "organizer_terms" | "organizer_dpa" | "organizer_content_rules";
  version: string;
}>;

const ORGANIZER_DOCUMENT_IDS: readonly string[] = [
  "organizer_terms",
  "organizer_dpa",
  "organizer_content_rules",
];

/** The documents still to accept as the API sends them; anything that is not a list of them is none. */
export function readLegalPending(value: unknown): readonly LegalPending[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    isRecord(item) &&
    typeof item["document"] === "string" &&
    ORGANIZER_DOCUMENT_IDS.includes(item["document"]) &&
    typeof item["version"] === "string"
      ? [{ document: item["document"] as LegalPending["document"], version: item["version"] }]
      : [],
  );
}

export type Me = Readonly<{
  id: string;
  email: string;
  /** A Questify platform admin: the console opens for them (T-210). */
  isAdmin: boolean;
  memberships: readonly Membership[];
}>;

export type MeResult =
  | Readonly<{ kind: "signed_in"; me: Me }>
  /** `ended` when the API said the session itself ran out, so the page can say so. */
  | Readonly<{ kind: "signed_out"; ended: boolean }>
  | Readonly<{ kind: "unavailable" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isScope = (value: unknown): value is readonly string[] | null =>
  value === null || (Array.isArray(value) && value.every((id) => typeof id === "string"));

function readMembership(value: unknown): Membership | undefined {
  if (
    isRecord(value) &&
    typeof value["organizerId"] === "string" &&
    typeof value["organizerName"] === "string" &&
    (value["role"] === "owner" || value["role"] === "editor") &&
    isScope(value["eventScope"])
  ) {
    const support = readGrants(value["support"]);
    return {
      organizerId: value["organizerId"],
      organizerName: value["organizerName"],
      role: value["role"],
      eventScope: value["eventScope"],
      suspension: readSuspension(value["suspension"]),
      legalPending: readLegalPending(value["legalPending"]),
      ...(support === undefined ? {} : { support }),
    };
  }
  return undefined;
}

/** A suspension as the API sends it, or null for none (or a shape this page does not know). */
export function readSuspension(value: unknown): Suspension | null {
  return isRecord(value) &&
    typeof value["reason"] === "string" &&
    typeof value["since"] === "string"
    ? { reason: value["reason"], since: value["since"] }
    : null;
}

function readGrants(value: unknown): Membership["support"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isRecord).flatMap((grant) =>
    typeof grant["grantId"] === "string" &&
    typeof grant["eventId"] === "string" &&
    typeof grant["expiresAt"] === "string"
      ? [
          {
            grantId: grant["grantId"],
            eventId: grant["eventId"],
            expiresAt: grant["expiresAt"],
            kind: grant["kind"] === "edit" ? ("edit" as const) : ("view" as const),
          },
        ]
      : [],
  );
}

/** Checks the `/me` answer's shape, so a changed API shows the error state instead of a broken page. */
function readMe(value: unknown): Me | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["email"] !== "string") {
    return undefined;
  }
  const raw = value["memberships"];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const memberships = raw.map(readMembership);
  if (memberships.some((membership) => membership === undefined)) {
    return undefined;
  }
  return {
    id: value["id"],
    email: value["email"],
    isAdmin: value["platformRole"] === "admin",
    memberships: memberships as Membership[],
  };
}

export type MeRequest = Readonly<{
  apiOrigin: string;
  sessionToken: string | undefined;
  /** The browser's chain as the edge sent it, so the API sees the real client here too. */
  forwardedFor: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/** Asks the API who holds this session. Server to server, over the private network, never cached. */
export async function fetchMe(request: MeRequest): Promise<MeResult> {
  if (request.sessionToken === undefined || request.sessionToken === "") {
    return { kind: "signed_out", ended: false };
  }
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${request.sessionToken}` });
  if (request.forwardedFor !== null) {
    headers.set("x-forwarded-for", request.forwardedFor);
  }
  try {
    const response = await (request.fetchImpl ?? fetch)(`${request.apiOrigin}/v1/staff/me`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 401) {
      return { kind: "signed_out", ended: isRecord(body) && body["code"] === "session_expired" };
    }
    const me = response.ok ? readMe(body) : undefined;
    return me === undefined ? { kind: "unavailable" } : { kind: "signed_in", me };
  } catch {
    return { kind: "unavailable" };
  }
}
