# T-507c: souvenir sponsor tags (plan note)

Tier B (ADR-355): no ledger, sign-in or tenant-boundary logic is changed. The tag is cosmetic metadata beside the souvenir;
the rule's frozen grant identity, the receipts and the recipients' provenance are not touched. Delivers FR-1302 and FR-1303
for souvenirs and the souvenir line of FR-1306 (T-608 note). Migration **0143** (new, undeployed). Choices: **ADR-570 to
ADR-574 and Q-530 to Q-532 (Proposed)**. Reuses T-507's `sponsor_tag` (0088, `sponsor_tag_set` as 0101 restated it,
`sponsor_tag_shown` as 0121 restated it with the held-reward check) and T-402b's `souvenir_rule` (0064).

## Data and doors (deny by default: nothing new is granted but the existing doors, which stay the same six)

- `sponsor_tag` gets a `souvenir` kind and a `souvenir_id` column with a same-event composite key to
  `souvenir_rule (id, event_id)`, ON DELETE CASCADE (a deleted draft takes its tag; an active or stopped rule is never
  deleted). One sponsor per souvenir (partial unique index). The shape CHECK is restated for four kinds. No new table, so
  event-duplicate's table list and the personal-data catalog (the new column has a foreign key) need no entry.
- `sponsor_tag_set` (the team door, owner/editor inside the event limit, one advisory lock per event) accepts `souvenir`: the
  rule must be of this event, any status (a draft may be tagged before it is activated; a stopped one keeps its label).
  Archived events refuse as before. No new route: `PUT …/sponsor-tags` takes the fourth kind, so the support view stays
  read-only through the same hook and `teamSeat`/`organizerContextOf` seat as every sponsor write.
- `sponsor_tag_shown` answers false for a souvenir tag, so `member_sponsors` (the event's strip and the tags on quests,
  categories and rewards) never names a souvenir; the member schema keeps its three kinds.
- Where a souvenir shows "presented by": only to its owner. `own_locker` (the profile's locker) gains `presented_by` and
  `event_recap` adds `presentedBy` to each souvenir it lists, both from one internal helper `souvenir_presented_by(rule)`
  (revoked from PUBLIC, no grant). `item_json` and every public item DTO (equipment, public profile, ranking) are untouched:
  an exact-key test holds them source-free and sponsor-free.
- `event_copy_extras` (0098) copies sponsor tags; it now skips a `souvenir` tag (duplicating an event copies no souvenir rule).
- `analytics_sponsor` (0103) adds `souvenirs` (the sponsor's non-draft souvenirs and how many players earned each, from
  receipts), floored like the other counts; the dashboard's sponsor view and the sponsor spreadsheet list them.
- Erasure and the export are unchanged: the tag holds no player; an erased player's receipt and item go as before and the
  label disappears with the item; the export lists the item and its source event (the sponsor is the organizer's label).

## App and dashboard

- Dashboard: the Sponsors page's tag editor gets a "Souvenirs" group (the event's souvenirs from `GET …/souvenirs`); the
  Souvenirs page shows the "Presented by" badge on a tagged card.
- App: the locker names the sponsor under "Souvenir from {event}" with the same mark and line as a quest card; the recap
  card puts the line in the souvenir's chip. Arabic and English, RTL, Western digits (`sponsors.presentedBy` is reused;
  one new dashboard group title and the analytics rows).

## Tests

`test/db/sponsor-souvenirs` (tag, move, clear, one sponsor per souvenir, other-event rule and sponsor, archived, kind
refused, cascade on sponsor delete and on draft delete, the FK race with a draft delete, locker and recap labels, public
DTO exact keys, `member_sponsors` silent, duplicate skip, erasure, analytics, cross-tenant and player/outsider seats),
`test/sponsors/routes` (HTTP, editor scope, support view), shared and web/app unit tests, the security suites, a Sponsors
page browser case.

## Mutation globs

None required (not tier A).
