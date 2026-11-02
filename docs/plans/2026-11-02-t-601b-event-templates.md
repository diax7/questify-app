# T-601b: event templates (plan note)

Tier B (ADR-355): a template writes setup rows (categories, quests, rewards, switches) into an empty draft of the caller's own
organizer. It touches no points, sign-in or tenant-isolation logic: the apply door runs behind `award_event_of` like
`event_copy_setup` (T-601), and the list door answers the signed-in team only. Delivers FR-1015 (F-189). Migration **0115**
(0114 is T-701's). Choices: **ADR-404 / Q-371 (Proposed)**.

## Where the templates live

`event_template` is a closed table (forced row-level security, no grant, as `city` and `interest`): key, order, the name and
description in both languages, `body jsonb`, `enabled`. The four shipped templates (`conference`, `festival`, `campus`,
`corporate`) are seeded by the migration; after that they are data. The Questify console edits the rows later (FR-1403, the
console's content task) and must validate a body with `templateBodySchema` (`packages/shared/src/templates`) before it saves
one, the same schema the API checks on every read. No template text is in code, so an edit needs no release.

## Body (one schema, `templateBodySchema`)

- `config`: `features` (event switches by registry key, only event-level ones), `accent` (a curated accent key) and
  `layoutPreset` (one of `LAYOUT_PRESETS`).
- `categories[]`: names, `orderMode`, `completionBonus`, and `quests[]`: type, title and description in both languages,
  points, repeat cap, and `typeConfig` in the **canonical form the quest registry produces** (a test parses each one with
  `QUEST_TYPES[type].config` and requires the same object back).
- `rewards[]`: `experience` and `digital` kinds only, with a price and no stock (`stock_total` 0; a digital reward's stock is
  its codes). **Item rewards are left out:** an item needs the prize desk's place (`reward_desk_guard`, FR-1716) and a new draft
  has none. The picker says so in one line; the organizer adds hand-over items after setting the desk.
- Quest types: `scan_qr`, `challenge`, `submission`, `vote`, `survey`, `share`, `meet`, `game`. Not `quiz` (it needs facts the
  template cannot know), not `passport`/`location`/`enter_code` (steps, places and secrets are the organizer's), and a template
  never holds a quest whose type switch the same template turns off.

## Doors (migration 0115)

- `event_templates()` (definer, API role): the enabled templates in order, for a signed-in staff member; AN404 otherwise.
- `event_apply_template(target, key, request)` (definer, API role): `award_event_of` (AN404), ET404 for an unknown or
  disabled key, ED409 unless the target is an empty draft (`event_copy_target_ok`, T-601's rule), then replaces the target's own
  General category with the template's categories, inserts quests and rewards with fresh ids, merges the template's switches and
  accent into `event.config` (bumping `config_version`), audits `event.template` with the key and counts. Answers the counts and
  the layout preset to apply. Nothing a player, a point, a code or a secret can be in it.
- `apply` and `create` share one service: the API reads the list (validating every body), and applies the layout preset
  through the layout writer in the same transaction.

## API

- `GET /v1/organizers/{id}/event-templates` (owner, editor): the picker's view of each template (names, categories with their
  quests' title, type and points, rewards with price, switches, accent), never a quiz answer or a typed config.
- `POST /v1/organizers/{id}/events` takes an optional `template` key; the event and its template are one transaction, so a failed
  apply leaves no event. An unknown key is 422 `invalid_event` (`field: template`).
- `POST …/events/{id}/template` `{template}` (owner, editor, Idempotency-Key): the wizard's "Start from" on an existing empty
  draft; 409 `event_not_empty` otherwise.

## Dashboard

- New-event page: a "Start from" picker above the details form (Start blank first and selected, then the four templates), each
  card with its name, one line and counts; the selected card opens a preview (categories, quests, rewards, switches).
- Wizard step 1: the same picker in a card above the details form while the draft is empty (`TemplateStart`), with a confirmation
  that names what it will add; a refusal says the event already has quests or rewards.
- Words in both languages (`templates.*`), Western digits, phone width, RTL, ADR-370 (titles and icons, no filler lines).

## Tests

`test/db/event-templates.int` (the shipped content against the shared schema, both languages, Western digits, apply result,
refusals ET404/ED409/AN404, one transaction), `test/events/templates.int` (routes, replay, unknown key, create+template atomic,
limited editor), `shared/templates/template.test.ts` (schema edges), `outsider` (closed table, two doors), `cross-tenant`,
`routes.int` (the two routes listed), `e2e/event-templates.spec.ts` (picker, preview, create from a template, blank, wizard).
