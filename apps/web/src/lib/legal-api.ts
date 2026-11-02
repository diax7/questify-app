import {
  helpPublicSchema,
  legalTextSchema,
  supportContactSchema,
  type HelpPublic,
  type LegalDocumentId,
  type LegalText,
  type SupportContact,
} from "@questify/shared";

type Request = Readonly<{ apiOrigin: string; timeoutMs?: number; fetchImpl?: typeof fetch }>;

/** One public GET, server to server; undefined for any answer that is not the expected shape. */
async function read(request: Request, path: string): Promise<unknown> {
  try {
    const response = await (request.fetchImpl ?? fetch)(`${request.apiOrigin}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(request.timeoutMs ?? 5000),
    });
    return response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** A legal document in force with its published texts (null for a version with none: the page shows the draft file). */
export async function fetchLegalText(
  request: Request,
  document: LegalDocumentId,
): Promise<LegalText | undefined> {
  const parsed = legalTextSchema.safeParse(await read(request, `/v1/legal/${document}`));
  return parsed.success ? parsed.data : undefined;
}

/** The support contact details; undefined when the API did not answer, so the page says they are being prepared. */
export async function fetchSupportContact(request: Request): Promise<SupportContact | undefined> {
  const parsed = supportContactSchema.safeParse(await read(request, "/v1/support-contact"));
  return parsed.success ? parsed.data : undefined;
}

/** The published help articles in order. */
export async function fetchHelp(request: Request): Promise<HelpPublic | undefined> {
  const parsed = helpPublicSchema.safeParse(await read(request, "/v1/help"));
  return parsed.success ? parsed.data : undefined;
}
