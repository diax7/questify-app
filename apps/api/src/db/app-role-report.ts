/** What `--verify` reads about the API's own role (migrate-cli.ts). */
export type AppRoleFacts = Readonly<{
  /** The role's own row in pg_roles, or undefined when it has none. */
  role: Readonly<{ who: string; superuser: boolean; bypass_rls: boolean }> | undefined;
  staffRows: number | undefined;
  eventRows: number | undefined;
  /** An insert into staff_user without an identity was refused. */
  blockedWrite: boolean;
  migrationTableReadable: boolean;
  /** The migration owner sees the API's sessions (ADR-224, migration 0053). */
  ownerSeesSessions: boolean;
}>;

/** The role is no superuser and does not bypass row-level security. */
const rolePlain = (role: AppRoleFacts["role"]): boolean =>
  role?.superuser === false && role.bypass_rls === false;

/** The answer `--verify` prints: whether every limit holds, and the facts behind it. */
export function appRoleReport(facts: AppRoleFacts) {
  const ok =
    rolePlain(facts.role) &&
    facts.staffRows === 0 &&
    facts.blockedWrite &&
    !facts.migrationTableReadable &&
    facts.ownerSeesSessions;
  return {
    ok,
    role: facts.role?.who,
    superuser: facts.role?.superuser,
    bypassRls: facts.role?.bypass_rls,
    staffRowsVisible: facts.staffRows,
    eventsVisible: facts.eventRows,
    unidentifiedInsertBlocked: facts.blockedWrite,
    migrationTableReadable: facts.migrationTableReadable,
    ownerSeesSessions: facts.ownerSeesSessions,
  };
}
