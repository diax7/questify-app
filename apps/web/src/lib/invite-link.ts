const TOKEN_IN_FRAGMENT = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/;

export type Invite = Readonly<{
  organizerName: string;
  role: "editor" | "owner";
  email: string;
  accountExists: boolean;
}>;

export type InviteState =
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "no_link"; message: string | null }>
  | Readonly<{ kind: "ready"; token: string; invite: Invite }>
  | Readonly<{ kind: "code"; token: string; invite: Invite; challengeToken: string }>;

/** The invite token in a URL fragment (`#token=…`, 43 URL-safe characters), or nothing. */
export const tokenFromHash = (hash: string): string | undefined =>
  TOKEN_IN_FRAGMENT.exec(hash)?.[1];

export const isInvite = (value: unknown): value is Invite =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)["organizerName"] === "string" &&
  typeof (value as Record<string, unknown>)["email"] === "string";

/** What the page shows once the link has been inspected: the invite, or why the link does not work. */
export function inspectedState(
  result: Readonly<{ ok: boolean; body: unknown }>,
  token: string,
  problemText: (body: unknown) => string,
): InviteState {
  return result.ok && isInvite(result.body)
    ? { kind: "ready", token, invite: result.body }
    : { kind: "no_link", message: problemText(result.body) };
}

/** The sign-in code challenge the API opened for a new member, or nothing when it did not. */
export function challengeOf(result: Readonly<{ ok: boolean; body: unknown }>): string | undefined {
  const challengeToken = (result.body as { challengeToken?: unknown } | undefined)?.challengeToken;
  return result.ok && typeof challengeToken === "string" ? challengeToken : undefined;
}

export type InviteMode = "accept" | "otherSignedIn" | "signIn" | "join";

/**
 * What the invite page offers: accept at once (signed in with the invited email), a note (signed in as someone
 * else), sign in here (an account exists), or choose a password (someone new).
 */
export function inviteModeOf(signedInEmail: string | null, invite: Invite): InviteMode {
  if (signedInEmail !== null) {
    return signedInEmail === invite.email ? "accept" : "otherSignedIn";
  }
  return invite.accountExists ? "signIn" : "join";
}
