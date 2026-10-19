import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  MESSAGES,
  isUsableOverride,
  validateTranslation,
  type ConfigIssue,
  type Language,
  type Messages,
  type Overrides,
} from "@questify/shared";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";
import { createTtlCache } from "#src/settings/cache";

export type Bundle = Readonly<{ overrides: Overrides; etag: string }>;

export type SaveTranslationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "invalid"; issues: readonly ConfigIssue[] }>
  | Readonly<{ ok: false; reason: "forbidden" }>;

export type TranslationService = Readonly<{
  /** Every value an admin has set that the app can use. Everything else comes from the shipped texts. */
  bundle: () => Promise<Bundle>;
  /** A Questify admin changes one or both languages of a key. A blank value removes that language's change. */
  save: (admin: PublicAccount, key: string, input: unknown) => Promise<SaveTranslationResult>;
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

/** Keeps only what the app can use: known keys, non-blank, with the shipped placeholders. */
function toOverrides(messages: Messages, rows: readonly Row[]): Overrides {
  const result: Record<Language, Record<string, string>> = { ar: {}, en: {} };
  for (const row of rows) {
    for (const language of ["ar", "en"] as const) {
      const text = row[language];
      if (text !== null && isUsableOverride(messages, row.key, language, text)) {
        result[language][row.key] = text;
      }
    }
  }
  return result;
}

async function writeRow(
  client: PoolClient,
  key: string,
  changes: Partial<Record<Language, string>>,
  adminId: string,
): Promise<void> {
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
  if (ar === null && en === null) {
    await client.query("DELETE FROM translation WHERE key = $1", [key]);
    return;
  }
  await client.query(
    `INSERT INTO translation (key, ar, en, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET ar = EXCLUDED.ar, en = EXCLUDED.en,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, ar, en, adminId],
  );
}

/** Reads and saves the texts an admin changed (F-277, FR-1766 to FR-1768). */
export function createTranslationService(options: TranslationOptions): TranslationService {
  const messages = options.messages ?? MESSAGES;
  const cache = createTtlCache<Bundle>({
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    maxEntries: 1,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    bundle: async () => {
      const cached = cache.get("bundle");
      if (cached !== undefined) {
        return cached;
      }
      const rows = await withConnection(options.pool, (client) =>
        withRequestContext(
          client,
          {},
          async () =>
            (await client.query<Row>("SELECT key, ar, en FROM translation ORDER BY key")).rows,
        ),
      );
      const overrides = toOverrides(messages, rows);
      const fresh = { overrides, etag: etagOf(overrides) };
      cache.set("bundle", fresh);
      return fresh;
    },

    save: async (admin, key, body) => {
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
      const changes: Partial<Record<Language, string>> = {};
      const issues: ConfigIssue[] = [];
      for (const language of ["ar", "en"] as const) {
        const text = parsed.data[language];
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
      if (issues.length > 0) {
        return { ok: false, reason: "invalid", issues };
      }
      await withConnection(options.pool, (client) =>
        withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () =>
          writeRow(client, key, changes, admin.id),
        ),
      );
      cache.clear();
      return { ok: true };
    },
  };
}
