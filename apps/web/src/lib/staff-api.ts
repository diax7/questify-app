/** The API's staff session cookie (apps/api/src/auth/session.ts). */
export const SESSION_COOKIE = "__Host-qs_session";

export type Membership = Readonly<{
  organizerId: string;
  organizerName: string;
  role: "owner" | "editor";
}>;

export type Me = Readonly<{ id: string; email: string; memberships: readonly Membership[] }>;

export type MeResult =
  | Readonly<{ kind: "signed_in"; me: Me }>
  /** `ended` when the API said the session itself ran out, so the page can say so. */
  | Readonly<{ kind: "signed_out"; ended: boolean }>
  | Readonly<{ kind: "unavailable" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function readMembership(value: unknown): Membership | undefined {
  if (
    isRecord(value) &&
    typeof value["organizerId"] === "string" &&
    typeof value["organizerName"] === "string" &&
    (value["role"] === "owner" || value["role"] === "editor")
  ) {
    return {
      organizerId: value["organizerId"],
      organizerName: value["organizerName"],
      role: value["role"],
    };
  }
  return undefined;
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
  return { id: value["id"], email: value["email"], memberships: memberships as Membership[] };
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
