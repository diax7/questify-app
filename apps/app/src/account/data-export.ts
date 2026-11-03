import { MESSAGES, dataExportFileName, type LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";

/** The native pieces the download needs: a file in the cache, the share sheet, and removing the file after. */
export type FileModules = Readonly<{
  /** Writes the text to a new file in the app's cache and answers its URI. */
  writeCacheFile: (name: string, text: string) => string;
  /** Opens the share sheet for the file; resolves when the sheet closes. */
  share: (uri: string) => Promise<void>;
  /** Removes the file; a file already gone is not an error. */
  remove: (uri: string) => void;
}>;

export type DataExportDeps = Readonly<{
  session: Pick<Session, "request">;
  /** Whether this build has the file and sharing modules (an older build may not). */
  modulesPresent: () => boolean;
  loadModules: () => FileModules;
  now: () => Date;
}>;

export type DataExportResult =
  | Readonly<{ kind: "shared" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "problem"; message: LocalizedText }>;

const OFFLINE = MESSAGES["signIn.offline"];
const SIGNED_OUT = MESSAGES["signIn.sessionEnded"];
const FAILED = MESSAGES["dataExport.failed"];

/** What a refused or failed answer says: the API's own words, or why there were none. */
function problemOf(answer: Exclude<AuthedResult, Readonly<{ kind: "ok" }>>): LocalizedText {
  if (answer.kind === "network") {
    return OFFLINE;
  }
  if (answer.kind === "signed_out") {
    return SIGNED_OUT;
  }
  return answer.message ?? FAILED;
}

/**
 * Downloads the player's own data (FR-1418, ADR-480): the API builds the file, the app writes it to its cache, opens
 * the share sheet so the player saves or sends it where they choose, and deletes the cache file when the sheet closes,
 * on success and on any error. Nothing else keeps a copy.
 */
export async function downloadMyData(deps: DataExportDeps): Promise<DataExportResult> {
  if (!deps.modulesPresent()) {
    return { kind: "unavailable" };
  }
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/me/data-export",
    body: {},
  });
  if (answer.kind !== "ok") {
    return { kind: "problem", message: problemOf(answer) };
  }
  const modules = deps.loadModules();
  let uri: string | undefined;
  try {
    uri = modules.writeCacheFile(
      dataExportFileName(deps.now()),
      JSON.stringify(answer.body, null, 2),
    );
    await modules.share(uri);
    return { kind: "shared" };
  } catch {
    return { kind: "problem", message: FAILED };
  } finally {
    if (uri !== undefined) {
      try {
        modules.remove(uri);
      } catch {
        // The cache file is the system's to clear when this fails; there is nothing more the app can do here.
      }
    }
  }
}
