import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  MESSAGES,
  buildMatrix,
  isLockedText,
  isUsableOverride,
  matrixRow,
  validateTranslation,
  type ConfigIssue,
  type Language,
  type Matrix,
  type MatrixQuery,
  type MatrixRow,
  type Messages,
  type Overrides,
} from "@questify/shared";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";
import { createTtlCache } from "#src/settings/cache";

export type Bundle = Readonly<{ overrides: Overrides; etag: string }>;

export type SaveTranslationResult =
  | Readonly<{ ok: true; row: MatrixRow }>
  | Readonly<{ ok: false; reason: "invalid"; issues: readonly ConfigIssue[] }>
  | Readonly<{ ok: false; reason: "forbidden" }>
  | Readonly<{ ok: false; reason: "locked" }>;

export type TranslationService = Readonly<{
  /** Every value an admin has set that the app can use. Everything else comes from the shipped texts. */
  bundle: () => Promise<Bundle>;
  /** Every shipped key with what an admin changed, narrowed and paged (FR-1765). For the console. */
  matrix: (query: MatrixQuery) => Promise<Matrix>;
  /**
   * A Questify admin changes one or both languages of a key and gets the key's row back. A blank value removes that
   * language's change (back to the shipped text). A legal or consent text is refused (`locked`).
   */
  save: (
    admin: PublicAccount,
    key: string,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<SaveTranslationResult>;
}>;

export type TranslationOptions = Readonly<{
  pool: Pool;
  messages?: Messages;
  ttlMs?: number;
  now?: () => number;
}>;

const DEFAULT_TTL_MS = 15_000;

const input = z.strictObject({ ar: z.string().optional(), en: z.string().optional() });

type Row = { key: string; ar: string | null; en: string | null };

/** Keeps only what the app can use: known keys, non-blank, with the shipped placeholders, never a legal text. */
function toOverrides(messages: Messages, rows: readonly Row[]): Overrides {
  const result: Record<Language, Record<string, string>> = { ar: {}, en: {} };
  for (const row of rows) {
    if (isLockedText(row.key)) {
      continue;
    }
    for (const language of ["ar", "en"] as const) {
      const text = row[language];
      if (text !== null && isUsableOverride(messages, row.key, language, text)) {
        result[language][row.key] = text;
      }
    }
  }
  return result;
}

/**
 * Applies the changed languages of one key, and records the change in the audit log in the same transaction.
 * A save that changes nothing writes nothing. Returns what the key holds afterwards.
 */
async function writeRow(
  client: PoolClient,
  key: string,
  changes: Partial<Record<Language, string>>,
  admin: PublicAccount,
  meta: AuditMeta,
): Promise<Row> {
  const { rows } = await client.query<Row>(
    "SELECT key, ar, en FROM translation WHERE key = $1 FOR UPDATE",
    [key],
  );
  const current = rows[0];
  const next = (language: Language): string | null => {
    const change = changes[language];
    if (change === undefined) {
      return current?.[language] ?? null;
    }
    return change === "" ? null : change;
  };
  const ar = next("ar");
  const en = next("en");
  const changed = diff({ ar: current?.ar ?? null, en: current?.en ?? null }, { ar, en });
  if (Object.keys(changed.after).length === 0) {
    return { key, ar, en };
  }
  if (ar === null && en === null) {
    await client.query("DELETE FROM translation WHERE key = $1", [key]);
  } else {
    await client.query(
      `INSERT INTO translation (key, ar, en, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET ar = EXCLUDED.ar, en = EXCLUDED.en,
         updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, ar, en, admin.id],
    );
  }
  await recordAudit(client, {
    actor: { type: "admin", id: admin.id },
    action: "translation.update",
    target: { type: "translation", id: key },
    ...changed,
    requestId: meta.requestId,
  });
  return { key, ar, en };
}

/** Checks the languages of a save; the values to store, or every issue found. */
function checkChanges(
  messages: Messages,
  key: string,
  body: Readonly<{ ar?: string | undefined; en?: string | undefined }>,
): Readonly<{ changes: Partial<Record<Language, string>>; issues: ConfigIssue[] }> {
  const changes: Partial<Record<Language, string>> = {};
  const issues: ConfigIssue[] = [];
  for (const language of ["ar", "en"] as const) {
    const text = body[language];
    if (text === undefined) {
      continue;
    }
    const checked = validateTranslation(messages, key, language, text);
    if (checked.ok) {
      changes[language] = checked.value;
    } else {
      issues.push(...checked.issues);
    }
  }
  return { changes, issues };
}

/** Reads and saves the texts an admin changed (F-277, FR-1765 to FR-1768). */
export function createTranslationService(options: TranslationOptions): TranslationService {
  const messages = options.messages ?? MESSAGES;
  const cache = createTtlCache<Bundle>({
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    maxEntries: 1,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const readRows = (): Promise<Row[]> =>
    withConnection(options.pool, (client) =>
      withRequestContext(
        client,
        {},
        async () =>
          (await client.query<Row>("SELECT key, ar, en FROM translation ORDER BY key")).rows,
      ),
    );

  return {
    bundle: async () => {
      const cached = cache.get("bundle");
      if (cached !== undefined) {
        return cached;
      }
      const overrides = toOverrides(messages, await readRows());
      const fresh = { overrides, etag: etagOf(overrides) };
      cache.set("bundle", fresh);
      return fresh;
    },

    matrix: async (query) => buildMatrix(messages, await readRows(), query),

    save: async (admin, key, body, meta = {}) => {
      if (admin.platformRole !== "admin" || admin.status !== "active") {
        return { ok: false, reason: "forbidden" };
      }
      const parsed = input.safeParse(body);
      if (!parsed.success || (parsed.data.ar === undefined && parsed.data.en === undefined)) {
        return {
          ok: false,
          reason: "invalid",
          issues: [{ path: "body", message: "must have ar, en or both, as text" }],
        };
      }
      const { changes, issues } = checkChanges(messages, key, parsed.data);
      if (issues.length > 0) {
        return { ok: false, reason: "invalid", issues };
      }
      if (isLockedText(key)) {
        return { ok: false, reason: "locked" };
      }
      const stored = await withConnection(options.pool, (client) =>
        withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () =>
          writeRow(client, key, changes, admin, meta),
        ),
      );
      cache.clear();
      return { ok: true, row: matrixRow(messages, key, stored) };
    },
  };
}
