import { legalInForceSchema, type LegalInForce } from "@questify/shared";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * The version in force of each legal document (migration 0123), read from the database every time: a published version
 * binds the next sign-in, acceptance and submission at once. The table is a handful of rows.
 *
 * @throws Error when the database answers something that is not a list of documents.
 */
export async function readInForce(db: Queryable): Promise<LegalInForce> {
  const { rows } = await db.query<{ r: unknown }>("SELECT legal_in_force() AS r");
  const parsed = legalInForceSchema.safeParse({ documents: rows[0]?.r });
  if (!parsed.success) {
    throw new Error("legal_in_force() did not answer a list of documents.");
  }
  return parsed.data.documents;
}
