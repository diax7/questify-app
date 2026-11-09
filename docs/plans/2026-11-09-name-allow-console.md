# The full-name allow-list from the console (FOLLOWUPS batch 23, FR-1779, ADR-817)

Tier B with an admin power. Short plan note; the build follows the word lists (T-705, migration 0120, 0177's doors).

- **Migration 0185, one file.** Doors `console_name_allow(search, language, after)`, `admin_name_allow_add(word, request)`,
  `admin_name_allow_remove(word, request)`: definers, `console_admin()` first (QE403), the lists' advisory key, audited
  `full_name_allow.add|remove` with the word. No reason and no re-authentication: the word lists take neither.
- **Normalisation.** The word is stored as `full_name_blocked` meets it: `full_name_fold` (not `username_fold`, so accents,
  NFKC forms and Persian letters fold as in a name). One word of 2+ letters, all Arabic or all English (WA400); the language
  is derived from the letters, since it decides whether the prefix and nisba forms are covered.
- **Refusals.** WA409: the word is a `username_word` entry. WA422: with the word inserted, an abusive name of the corpus
  that is refused now passes. The corpus' abusive names are copied into `full_name_probe` (no grant); only the probes whose
  space-free fold holds the word are checked (an allow word skips only a word of a name that holds it), before and after the
  insert, in the same transaction; a refusal rolls the insert and the sweep mark back.
- **Recheck.** The statement trigger `full_name_allow_recheck` (0177) marks the sweep; the door runs no page. Tested.
- **API.** `GET|POST /v1/admin/name-allow`, `DELETE /v1/admin/name-allow/{word}`, the word lists' read and write buckets.
- **Web.** `/console/name-allow` beside the word lists: add, search, language filter, list with Remove asked once, the
  word lists' empty and error states; history words `console.history.nameAllow`.
- **Tests.** `test/db/name-allow-console.int` (seats, folding, page, refusals, every abusive corpus word through the door,
  the sweep, the probe table equal to the corpus), `test/console/safety.int`, the security suites, the Playwright spec.
