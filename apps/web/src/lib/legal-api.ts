import {
  helpPublicSchema,
  legalTextSchema,
  type HelpPublic,
  type LegalDocumentId,
  type LegalText,
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

/** The published help articles in order. */
export async function fetchHelp(request: Request): Promise<HelpPublic | undefined> {
  const parsed = helpPublicSchema.safeParse(await read(request, "/v1/help"));
  return parsed.success ? parsed.data : undefined;
}
