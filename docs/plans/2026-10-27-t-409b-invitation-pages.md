# T-409b — The web pages for Questify invitations

Delivers FR-738 and FR-739 on screen. Standard bar (web only). The server half (T-409; routes, schemas, ADR-329 to
ADR-334) is built; this task reads its exact shapes (`docs/API.md`, `packages/shared/src/invitation-campaigns/`) and
adds no route. Choices are **Proposed ADR-335 / Q-304**.

## Pieces

| Surface | Path | Who | What |
|---|---|---|---|
| Dashboard | `/[lang]/organizers/{o}/events/{e}/invitations` | owner, editor | The event's requests newest first (state, criteria, size, the approved cap and send time, the admin's note, the end reason, rounded counts "120+" / "Fewer than 10" / "Not published yet", "Updated daily"); the request form and Withdraw for the owner only; "Nothing is charged here" and "only rounded counts, never who". The event nav shows the link only while the platform switch is on (`enabled`). |
| Console | `/[lang]/console/invitations`, `/[lang]/console/invitations/{id}` | platform admin | The queue (open first, then the latest 100 closed) with exact counts. The detail: facts, the audience estimate now, the event's names and each name rule verdict, the exact SMS text (both languages, parts, placeholder token), the channel hold banner, exact counters; Approve (SMS, cap, send time in Riyadh time, note; sends back the names it showed), Refuse and Cancel (a required note). `event_renamed` reloads the detail and asks to review the new text. The console home links to the queue with the number of requests waiting. |
| Landing | `/[lang]/i#{token}` | anyone with the link | Reads the token from the fragment once, clears it (`history.replaceState`, the `InviteFlow` precedent), POSTs it once to `POST /v1/public/invitation-open`, shows the public event card and "Open in Questify" (the plain join link `/{lang}/e/{code}`), or "This invitation has ended". Never indexed, no referrer (the `op` and `pair` pages' metadata). No language switch: it would drop the link's token (the `invite` page's reason). |

## Decisions taken (recorded as Proposed ADR-335 / Q-304)

1. **The console detail renders the messages from the frozen names once a request is approved.** The API rendered them
   from the event's current names in every state, so after a rename the console would have shown text that is not what
   goes out. One small change in `campaignDetail` (`apps/api/src/invitation-campaigns/campaigns.ts`): `requested` renders
   the current names (what Approve will freeze), every later state renders `approvedNames`. A refused request, or one
   cancelled before approval, has no text to show (`messages: null`).
2. **Times are Riyadh time.** The earliest-send field and the console's send-time field are `datetime-local` in
   `Asia/Riyadh` (the quiet hours are Riyadh hours, and the console's other forms already work in Saudi time); displayed
   times name the zone.
3. **The Arabic word is «طلب دعوات», not «حملة».** «الحملات»/«المواسم» already means the Questify campaigns in the
   console; the English UI says "invitation request".
4. **No per-state polling.** The page reads on arrival and after each action; a request approved meanwhile shows on the
   next load.

## Tests

Unit (`apps/web/src/lib`): readers (valid answers, extra keys refused), count wording, request body and validation, the
approval body (frozen names, Riyadh time), refusal mapping (`event_not_eligible` reasons, `event_name`, `event_renamed`),
the landing token reader. API: the detail's frozen-text rule. Browser (`apps/web/e2e/invitations.spec.ts`, desktop and
phone, Arabic and English): owner requests (a refused event first, then an eligible one), sees "Fewer than 10"/"Not
published yet", withdraws; an editor sees no form; the admin approves (the moved send time, the exact text, `event_renamed`
after a rename), refuses, cancels; the landing page counts one open and shows the card, the ended and the incomplete
cases; no sideways scroll. `apps/web/e2e/organizers.spec.ts`' owner-only count is unchanged (the Invitations page uses
its own sentence, not "Only the owner can change this.").
