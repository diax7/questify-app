import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserHeaders,
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The outsider and cross-tenant suites on the HTTP routes (T-012). Every route must appear in ROUTES with how it
 * keeps one caller out of another's data; a new route fails the first test until that is decided and proven.
 */
const ROUTES: Readonly<Record<string, string>> = {
  "GET /v1/me/locker": "caller-owned inventory through own_locker (profile-items)",
  "POST /v1/me/locker/seen": "caller-owned acknowledgment only (profile-items)",
  "GET /v1/players/:username":
    "active-player public DTO allowlist, no account details (profile-items HTTP)",
  "GET /healthz": "no data: process liveness",
  "GET /readyz": "no data: database reachability",
  "GET /v1/translations": "no tenant data: the same platform texts for everyone",
  "GET /v1/config": "another organizer's private event answers like a missing one (tested below)",
  "POST /v1/staff/auth/password":
    "sign-in step; answers the same for every account (test/auth/sign-in)",
  "POST /v1/staff/auth/code": "sign-in step; bound to its own challenge token (test/auth/sign-in)",
  "POST /v1/staff/auth/resend":
    "sign-in step; bound to its own challenge token (test/auth/sign-in)",
  "GET /v1/staff/me": "only the caller's own account and memberships (tested below)",
  "GET /v1/staff/sessions": "only the caller's own sessions (tested below)",
  "DELETE /v1/staff/sessions/:id":
    "another person's session answers 404 and stays live (tested below)",
  "POST /v1/staff/auth/sign-out": "ends only the caller's own session (tested below)",
  "POST /v1/staff/auth/reset/request":
    "names no account: the same 202 for every email; the link goes only to the account's own mailbox (test/auth/password-reset)",
  "POST /v1/staff/auth/reset/confirm":
    "bound to the one link its secret token opens (test/auth/password-reset, test/db/password-reset)",
  "POST /v1/staff/auth/sign-up":
    "names no account: the same answer for a new and an existing email; only the mailbox owner reads the email (test/auth/sign-up)",
  "POST /v1/staff/auth/sign-up/code":
    "bound to its own pending sign-up token; creates only that sign-up's account (test/auth/sign-up)",
  "POST /v1/staff/auth/sign-up/resend":
    "bound to its own pending sign-up token (test/auth/sign-up)",
  "POST /v1/staff/organizers":
    "creates an organizer owned by the caller only; the database sets the owner from the session (test/auth/sign-up)",
  "POST /v1/staff/invites/inspect":
    "shows only the invite its secret token opens; the token's holder already proved the mailbox (test/organizers/team)",
  "POST /v1/staff/invites/accept":
    "the database accepts only for the account the invite was sent to (test/organizers/team, test/db/organizer-team)",
  "POST /v1/staff/invites/accept-new":
    "bound to its own invite token; creates only the invited email's account, then a normal sign-in code (test/organizers/team)",
  "POST /v1/organizers/:organizerId/invites":
    "owner of that organizer only (owner route, walked below)",
  "POST /v1/organizers/:organizerId/ownership":
    "owner of that organizer only (owner route, walked below)",
  "DELETE /v1/organizers/:organizerId/invites/:inviteId":
    "owner only; another organizer's invite id deletes nothing (404)",
  "PATCH /v1/organizers/:organizerId/members/:staffUserId":
    "owner only; only this organizer's editors and events (test/organizers/team)",
  "DELETE /v1/organizers/:organizerId/members/:staffUserId":
    "owner only; only this organizer's editors, never the owner (test/organizers/team)",
  "DELETE /v1/organizers/:organizerId/members/me":
    "the caller leaves; the owner cannot (test/organizers/team)",
  "GET /v1/organizers/:organizerId/members":
    "members of that organizer only: the membership is read from the database, a non-member gets 404 (tested below)",
  "GET /v1/organizers/:organizerId/events":
    "members of that organizer only; a limited editor sees only their events (test/events/events)",
  "POST /v1/organizers/:organizerId/events":
    "members of that organizer only; the database sets nothing outside it; a limited editor cannot create (test/events/events)",
  "GET /v1/organizers/:organizerId/events/:eventId":
    "another organizer's event, or one outside an editor's limit, answers 404 (test/events/events)",
  "PATCH /v1/organizers/:organizerId/events/:eventId":
    "only this organizer's events within the caller's limit; status and organizer are not writable (test/events/events, test/db/event-lifecycle)",
  "DELETE /v1/organizers/:organizerId/events/:eventId":
    "only this organizer's drafts within the caller's limit (test/events/events, test/db/event-lifecycle)",
  "POST /v1/organizers/:organizerId/events/:eventId/end":
    "owner only (walked below); the database checks the owner again (test/events/events, test/db/event-lifecycle)",
  "GET /v1/organizers/:organizerId/events/:eventId/quests":
    "members of that organizer within their event limit; another event answers 404 (test/quests/builder)",
  "POST /v1/organizers/:organizerId/events/:eventId/categories":
    "only into the path's event, which the caller may reach; the database sets the organizer (test/quests/builder, test/db/quest-builder)",
  "PUT /v1/organizers/:organizerId/events/:eventId/categories/order":
    "only the path's event's categories, as an exact set (test/quests/builder)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/categories/:categoryId":
    "a category of another event answers 404 (test/quests/builder)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/categories/:categoryId":
    "a category of another event answers 404; quests move only within the event (test/quests/builder)",
  "PUT /v1/organizers/:organizerId/events/:eventId/categories/:categoryId/quests/order":
    "a category of another event answers 404 (test/quests/builder)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests":
    "only into a category of the path's event (test/quests/builder, test/db/quest-builder)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/quests/:questId":
    "a quest of another event answers 404, so a live event's confirmation cannot be skipped (test/quests/builder)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/quests/:questId":
    "a quest of another event answers 404 (test/quests/builder)",
  "GET /v1/organizers/:organizerId/events/:eventId/codes":
    "members of that organizer within their event limit; another event answers 404 (test/quests/codes)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/qr/regenerate":
    "a quest of the path's event only; another event's quest answers 404 (test/quests/codes)",
  "POST /v1/organizers/:organizerId/events/:eventId/categories/:categoryId/reveal/regenerate":
    "a hidden category of the path's event only, under row-level security; another event's or a shown category answers 404 (test/reveal)",
  "POST /v1/organizers/:organizerId/events/:eventId/steps/:stepId/qr/regenerate":
    "a passport step of the path's event only, under row-level security; another event's step answers 404 (test/plays/passport)",
  "GET /v1/organizers/:organizerId/events/:eventId/rewards":
    "members of that organizer within their event limit, under row-level security; another organizer's event answers 404 (test/rewards/routes, test/rewards/rewards)",
  "POST /v1/organizers/:organizerId/events/:eventId/rewards":
    "only into the path's event, which the caller may reach; the database sets the organizer (test/rewards/routes, test/security/cross-tenant)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/rewards/:rewardId":
    "a reward of another event answers 404; units out are never the API's to write (test/rewards/routes, test/rewards/rewards)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/rewards/:rewardId":
    "a reward of another event answers 404; audited (test/rewards/routes)",
  "POST /v1/organizers/:organizerId/events/:eventId/rewards/:rewardId/codes":
    "a reward of another event answers 404; add_reward_codes checks the caller's organizer and events again; codes are sealed before the database and never audited (test/rewards/codes-routes, test/rewards/spend-and-codes)",
  "PUT /v1/organizers/:organizerId/events/:eventId/shop":
    "members of that organizer within their event limit; another organizer's event answers 404; audited (test/rewards/routes)",
  "GET /v1/events/:eventId/shop":
    "an active member of that event only, through event_shop, shop_rewards and my_redemptions bound to the session; anyone else 404 (test/rewards/routes, test/rewards/rewards)",
  "POST /v1/rewards/:rewardId/reserve":
    "reserves only for the bearer, through reserve_reward bound to the session; another event's reward answers 404 (test/rewards/routes, test/rewards/rewards)",
  "PUT /v1/events/:eventId/goal":
    "pins only the bearer's own goal, through set_goal bound to the session; a stranger or another event's reward answers 404 (test/rewards/routes, test/db/goal)",
  "POST /v1/redemptions/:redemptionId/cancel":
    "cancels only the bearer's own reservation, through cancel_redemption bound to the session; another's answers 404 (test/rewards/routes, test/rewards/rewards)",
  "POST /v1/quests/:questId/complete":
    "a player's own bearer session only; the database writes for the player of the request, never an argument (test/completions/complete, test/db/completion-engine)",
  "POST /v1/staff/password":
    "changes only the caller's own password, after their current one (test/auth/password-reset)",
  "GET /v1/events/:eventId/config":
    "a player who joined the event (row-level security on the player's own context); anyone else 404, the reading cached per player (test/home/home)",
  "GET /v1/events/:eventId/ranking":
    "a player with an active enrollment in that event only; the definers read the caller from the session, never an argument (test/ranking/ranking, test/db/ranking)",
  "PUT /v1/organizers/:organizerId/events/:eventId/terms":
    "a member of that organizer, an editor within their chosen events (the database applies the limit); another organizer's event answers 404 (test/events/events)",
  "PUT /v1/organizers/:organizerId/events/:eventId/ranking":
    "the organizer's owner only, for an event of that organizer; another organizer's event answers 404 (test/ranking/ranking)",
  "PUT /v1/organizers/:organizerId/events/:eventId/ranking-today":
    "the organizer's owner only, for an event of that organizer (the same handler as the ranking switch); an editor answers 403 (test/ranking/ranking)",
  "PUT /v1/organizers/:organizerId/events/:eventId/meet-someone":
    "owner of that organizer only (owner route, walked below); changes only the meetSomeone switch of that event (test/plays/meet)",
  "POST /v1/quests/:questId/meet-pass":
    "the calling player's own active enrollment in the quest's event only; a code for the caller alone, kept as a hash, through issue_meet_pass (test/plays/meet, test/db/meet)",
  "GET /v1/meet-passes/:passId":
    "the calling player's own code only; another player's code answers 404, through meet_pass_state (test/plays/meet, test/db/meet)",
  "POST /v1/meet":
    "the scanner's own enrollment in the code's event only (not_in_event, naming no one, otherwise); the other player is named by username and avatar only, never their id, through meet_player (test/plays/meet, test/db/meet)",
  "POST /v1/taps":
    "the player's own enrollment in the tag's event only: an unknown, revoked or another event's tag answers 404 unknown_tag (NT404 in tap_quest), the quest is the tag's, never the caller's choice; per player at most 60 a minute (test/nfc/routes, test/db/nfc-tags)",
  "POST /v1/operator/events/:eventId/quests/:questId/nfc-tags/prepare":
    "an operator of that event with write_nfc only (OP403, OA403, OS403 in nfc_writer); a quest of another event answers 404; stores nothing; per operator at most 60 a minute (test/nfc/routes, test/db/nfc-tags)",
  "POST /v1/operator/events/:eventId/quests/:questId/nfc-tags":
    "the same operator, event, quest and tag the write ticket was issued for (CTO B), then nfc_writer's checks again in register_nfc_tag; per operator at most 60 a minute (test/nfc/routes, test/db/nfc-tags)",
  "GET /v1/operator/events/:eventId/nfc-tags":
    "an operator of that event with write_nfc only; their own writes only (operator_nfc_tags) (test/nfc/routes, test/db/nfc-tags)",
  "GET /v1/organizers/:organizerId/events/:eventId/quests/:questId/nfc-tags":
    "members of that organizer only, inside their event limit; another organizer's event answers 404 (AN404 in quest_nfc_tags) (test/nfc/routes, test/db/nfc-tags)",
  "POST /v1/organizers/:organizerId/events/:eventId/nfc-tags/:tagId/move":
    "members inside their event limit; a tag and a quest of that event only (NT404, NT409 not_nfc in move_nfc_tag) (test/nfc/routes, test/db/nfc-tags)",
  "POST /v1/organizers/:organizerId/events/:eventId/nfc-tags/:tagId/revoke":
    "members inside their event limit; a tag of that event only (NT404 in revoke_nfc_tag) (test/nfc/routes, test/db/nfc-tags)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/nfc-tags/revoke-all":
    "members inside their event limit; a quest of that event only (AN404 in revoke_quest_nfc_tags) (test/nfc/routes, test/db/nfc-tags)",
  "POST /v1/device/pairing":
    "public, Origin checked: writes only a pairing request that holds no one's data (the hashes of the browser's own secret and code); a call with a live device cookie answers that device's own state; 60 per 10 minutes per address bucket (test/devices/routes, test/db/devices)",
  "GET /v1/device":
    "the device cookie's own row only (device_session by its secret's hash); nothing of an event before activation; per device at most 30 a minute (test/devices/routes, test/db/devices)",
  "POST /v1/device/pairing/renew":
    "the device cookie's own pending request only, a new code under the same secret (test/devices/routes, test/db/devices)",
  "POST /v1/device/activate":
    "the device cookie's own paired device only; replaces its secret under the row lock (activate_device, CTO 2) (test/devices/routes, test/db/devices)",
  "GET /v1/device/screen-code":
    "a paired, activated station's own quest only (screen_code_for_device takes no quest); per device at most 6 a minute (test/devices/routes, test/db/devices)",
  "POST /v1/device/kiosk-scans":
    "a paired, activated kiosk's own quest only (kiosk_complete_quest takes no quest or event); the player is the one whose live code it read, paid only in the kiosk's own event (QC404); a UUID Idempotency-Key, namespaced in the door; per kiosk at most 30 scans and 10 bad codes a minute (test/devices/kiosk-routes, test/db/kiosks)",
  "GET /v1/me/live-code":
    "the signed-in player's own code only (their id from the bearer, the window from the database); per player at most 6 a minute (test/devices/kiosk-routes)",
  "POST /v1/operator/events/:eventId/devices/preview":
    "an operator of that event only (OP403 in preview_device); a code is unknown_code until it exists; claims and previews held at 10 a minute per operator and 30 unknown codes an hour per event (test/devices/routes, test/db/devices)",
  "POST /v1/operator/events/:eventId/devices":
    "an operator of that event with show_rotating_qr (or scan_quests for a kiosk), within their quest limit, never a big screen (device_operator in operator_claim_device) (test/devices/routes, test/db/devices)",
  "GET /v1/operator/events/:eventId/devices":
    "an operator of that event only; the devices they paired themselves (operator_devices) (test/devices/routes, test/db/devices)",
  "POST /v1/operator/events/:eventId/devices/:deviceId/revoke":
    "an operator of that event only, for a device they paired; any other answers 404 (DN404 in revoke_device) (test/devices/routes, test/db/devices)",
  "GET /v1/operator/events/:eventId/quests/:questId/screen-code":
    "an operator of that event with show_rotating_qr, within their quest limit (device_operator in screen_code_for_operator); per operator and quest at most 6 a minute (test/devices/routes, test/db/devices)",
  "GET /v1/organizers/:organizerId/events/:eventId/devices":
    "members inside their event limit; another organizer's event answers 404 (AN404 in event_devices); never a secret or code (test/devices/routes, test/db/devices)",
  "POST /v1/organizers/:organizerId/events/:eventId/devices/preview":
    "members inside their event limit (AN404 in preview_device); unknown codes held at 30 an hour per event and per organizer (test/devices/routes, test/db/devices)",
  "POST /v1/organizers/:organizerId/events/:eventId/devices":
    "members inside their event limit; a quest of that event only (team_claim_device) (test/devices/routes, test/db/devices)",
  "POST /v1/organizers/:organizerId/events/:eventId/devices/:deviceId/revoke":
    "members inside their event limit; a device of that event only (DN404 in revoke_device) (test/devices/routes, test/db/devices)",
  "POST /v1/organizers/:organizerId/events/:eventId/devices/revoke":
    "members inside their event limit; that event's devices only (revoke_devices) (test/devices/routes, test/db/devices)",
  "GET /v1/organizers/:organizerId/events/:eventId/community-goals":
    "members of that organizer only (member route, walked below); another organizer's event answers 404 (AN404 in community_goals) (test/community/routes, test/db/community)",
  "POST /v1/organizers/:organizerId/events/:eventId/community-goals":
    "members of that organizer only, inside their event limit; another organizer's event answers 404 (AN404 in save_community_goal) (test/community/routes, test/db/community)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/community-goals/:goalId":
    "members of that organizer only; a goal of another event answers 404 (GN404 in save_community_goal) (test/community/routes, test/db/community)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/community-goals/:goalId":
    "members of that organizer only; a goal of another event answers 404 (GN404 in delete_community_goal) (test/community/routes, test/db/community)",
  "POST /v1/organizers/:organizerId/events/:eventId/community/settle":
    "the organizer's owner only (owner route, walked below; CO403 in settle_community for an editor); another organizer's event answers 404; the payer then runs for that event only (test/community/routes, test/db/community)",
  "PUT /v1/organizers/:organizerId/events/:eventId/community":
    "owner of that organizer only (owner route, walked below); changes only the community switch of that event (test/community/routes)",
  "PUT /v1/organizers/:organizerId/events/:eventId/flash-quests":
    "owner of that organizer only (owner route, walked below); changes only the flashQuests switch of that event (test/quests/flash)",
  "PUT /v1/organizers/:organizerId/events/:eventId/double-points":
    "owner of that organizer only (owner route, walked below); changes only the boosts switch of that event (test/boosts/routes)",
  "PUT /v1/organizers/:organizerId/events/:eventId/help-desk":
    "owner of that organizer only (owner route, walked below); changes only the helpDesk switch of that event (test/tickets/routes)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/launch":
    "members inside their event limit; a flash quest of that event only, through launch_flash (test/quests/flash, test/db/flash-boosts)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/end":
    "members inside their event limit; a flash quest of that event only, through end_flash (test/quests/flash, test/db/flash-boosts)",
  "GET /v1/organizers/:organizerId/events/:eventId/boosts":
    "members of that organizer only, inside their event limit; another organizer's event answers 404 (AN404 in event_boosts) (test/boosts/routes, test/db/flash-boosts)",
  "POST /v1/organizers/:organizerId/events/:eventId/boosts":
    "members inside their event limit; a category of that event only (BO422 category), through save_boost (test/boosts/routes, test/db/flash-boosts)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/boosts/:boostId":
    "members inside their event limit; a boost of another event answers 404 (BN404 in save_boost) (test/boosts/routes, test/db/flash-boosts)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/boosts/:boostId":
    "members inside their event limit; a boost of another event answers 404 (BN404 in delete_boost) (test/boosts/routes, test/db/flash-boosts)",
  "POST /v1/organizers/:organizerId/events/:eventId/boosts/:boostId/end":
    "members inside their event limit; a boost of another event answers 404 (BN404 in end_boost) (test/boosts/routes, test/db/flash-boosts)",
  "PUT /v1/organizers/:organizerId/events/:eventId/mini-games":
    "owner of that organizer only (owner route, walked below); changes only the miniGames switch of that event (test/plays/games)",
  "GET /v1/quests/:questId/game":
    "the calling player's own enrollment in the quest's event only (QC404 otherwise), through member_game (test/plays/games, test/db/games)",
  "POST /v1/quests/:questId/game-rounds":
    "the calling player's own active enrollment in the quest's event only; the round is the caller's, issued by start_game_round (test/plays/games, test/db/games)",
  "POST /v1/game-rounds/:roundId/result":
    "the calling player's own round only; another player's round answers 404, through game_round_for_replay and finish_game_round (test/plays/games, test/db/games)",
  "PUT /v1/organizers/:organizerId/events/:eventId/share-quests":
    "the organizer's owner only, for an event of that organizer (the same handler as the ranking switch) (test/plays/survey-share, test/ranking/ranking)",
  "GET /v1/me":
    "the bearer's own profile only; the player comes from the session (test/players/profile)",
  "GET /v1/public/events":
    "no tenant data: public events that list themselves, through public_events with named columns only (test/join/join, test/db/join)",
  "GET /v1/public/events/:joinCode":
    "one event's card by its code, the secret that grants it; no organizer or player data; wrong codes are throttled (test/join/join, test/db/join)",
  "GET /v1/public/events/:joinCode/quests":
    "public and unlisted events' visible quests by named columns, never type_config; a private event answers members_only (test/join/join, test/db/join)",
  "POST /v1/join":
    "enrolls only the bearer, through join_event or join_invited bound to the session; nobody inserts an enrollment directly; an invitation not the bearer's answers 404 (test/join/join, test/join/join-fields, test/db/join, test/db/join-fields)",
  "GET /v1/rehearsals/:code":
    "the event a rehearsal code opens, for a signed-in player holding the code (the secret that grants it); no organizer or player data; wrong codes count against the join budget (test/rehearsal/rehearsal, test/db/rehearsal)",
  "POST /v1/rehearsals/join":
    "enrolls only the bearer as a rehearsal account, through join_rehearsal bound to the session; wrong codes are throttled (test/rehearsal/rehearsal, test/db/rehearsal)",
  "GET /v1/organizers/:organizerId/events/:eventId/rehearsal":
    "owners and editors of that organizer within their event limit, through rehearsal_card and award_event_of; another organizer's event answers 404 (test/rehearsal/rehearsal, test/db/rehearsal)",
  "POST /v1/organizers/:organizerId/events/:eventId/rehearsal/code":
    "owners and editors within their event limit, through rotate_rehearsal_code; audited; another organizer's event answers 404 (test/rehearsal/rehearsal, test/db/rehearsal)",
  "POST /v1/organizers/:organizerId/events/:eventId/rehearsal/erase":
    "owners and editors within their event limit, through erase_rehearsal; audited; another organizer's event answers 404 (test/rehearsal/rehearsal, test/db/rehearsal)",
  "GET /v1/me/invitations":
    "the bearer's own invitations only, through my_invitations bound to the session's verified contacts; no join code (test/join/join-fields, test/db/join-fields)",
  "GET /v1/organizers/:organizerId/events/:eventId/join":
    "members of that organizer within their event limit, read under row-level security; another organizer's event answers 404 (test/join/join-fields)",
  "PUT /v1/organizers/:organizerId/events/:eventId/join/fields":
    "members of that organizer within their event limit, written under row-level security with the event locked and the version checked; audited (test/join/join-fields, test/db/join-fields)",
  "PUT /v1/organizers/:organizerId/events/:eventId/join/rules":
    "members of that organizer within their event limit; the welcome amount guarded in the database once anyone joined or the event is live; audited (test/join/join-fields, test/db/join-fields)",
  "GET /v1/organizers/:organizerId/events/:eventId/join/guests":
    "members of that organizer within their event limit, read under row-level security; contacts masked (test/join/join-fields, test/db/join-fields)",
  "POST /v1/organizers/:organizerId/events/:eventId/join/guests":
    "members of that organizer within their event limit, written under row-level security; the audit keeps counts, never a contact (test/join/join-fields, test/db/join-fields)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/join/guests/:guestId":
    "members of that organizer within their event limit; another event's entry answers 404 (test/join/join-fields)",
  "GET /v1/organizers/:organizerId/events/:eventId/audience":
    "members of that organizer within their event limit; another event answers 404; reach as counts only, through audience_counts (test/audience/audience, test/db/targeting)",
  "PUT /v1/organizers/:organizerId/events/:eventId/audience/categories/:itemId":
    "members of that organizer within their event limit; set_audience checks the scope, the event lock and the options again, and audits ids and counts only (test/audience/audience, test/db/targeting)",
  "PUT /v1/organizers/:organizerId/events/:eventId/audience/rewards/:itemId":
    "members of that organizer within their event limit; set_audience checks again (test/audience/audience, test/db/targeting)",
  "GET /v1/me/events":
    "the bearer's own enrollments only, read under row-level security (test/join/join)",
  "POST /v1/events/:eventId/leave":
    "leaves only the bearer's own enrollment, read and written under row-level security (test/join/leave)",
  "GET /v1/events/:eventId/home":
    "the bearer's own enrollment in that event only, read under row-level security; strangers and former members answer not_enrolled whether or not the event exists (test/home/home)",
  "GET /v1/events/:eventId/activity":
    "the bearer's own ledger entries in that event only, through member_activity bound to the session; strangers and former members answer not_enrolled (test/home/home, test/db/activity)",
  "GET /v1/events/:eventId/quests":
    "an active member of that event only, through member_event_quests bound to the session; named columns, never type_config (test/home/home, test/db/event-home)",
  "PUT /v1/organizers/:organizerId/events/:eventId/focus":
    "members of that organizer within their event limit; only a quest of the path's event, another answers 404; audited (test/home/home, test/db/event-home)",
  "GET /v1/organizers/:organizerId/events/:eventId/players":
    "members of that organizer within their event limit, through event_players with the join card's columns; another event answers an empty list (test/moderation/moderation, test/db/bans)",
  "PUT /v1/organizers/:organizerId/events/:eventId/players/:enrollmentId/ban":
    "the organizer's owner only, for an enrollment of the path's event; set_enrollment_ban checks again and audits (test/moderation/moderation, test/db/bans)",
  "GET /v1/organizers/:organizerId/events/:eventId/join-requests":
    "members of that organizer within their event limit, through join_requests (public profile only); another event answers 404 (test/moderation/join-requests, test/db/join-requests)",
  "POST /v1/organizers/:organizerId/events/:eventId/join-requests/:enrollmentId/accept":
    "members of that organizer within their event limit; decide_join_request checks the scope, the seat under the seat lock and the event's state again, and audits (test/moderation/join-requests, test/db/join-requests)",
  "POST /v1/organizers/:organizerId/events/:eventId/join-requests/:enrollmentId/decline":
    "members of that organizer within their event limit; decide_join_request checks again and audits (test/moderation/join-requests, test/db/join-requests)",
  "POST /v1/organizers/:organizerId/events/:eventId/join-requests/accept-all":
    "members of that organizer within their event limit; accept_all_join_requests takes the seat lock once and audits each acceptance (test/moderation/join-requests, test/db/join-requests)",
  "GET /v1/organizers/:organizerId/events/:eventId/exclusions":
    "members of that organizer within their event limit; phones masked for every seat; another event answers 404 (test/moderation/moderation)",
  "POST /v1/organizers/:organizerId/events/:eventId/exclusions":
    "the organizer's owner only, for the path's event; add_exclusion checks again and audits the kind, never the value (test/moderation/moderation, test/db/bans)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/exclusions/:exclusionId":
    "the organizer's owner only; another event's or organizer's entry answers 404 (test/moderation/moderation, test/db/bans)",
  "GET /v1/organizers/:organizerId/events/:eventId/operators":
    "members of that organizer within their event limit, through event_operators and event_operator_invites; claim addresses only for the owner; another event answers 404 (test/operators/operators, test/db/operators)",
  "POST /v1/organizers/:organizerId/events/:eventId/operators/invites":
    "the organizer's owner only, for the path's event; create_operator_invites checks again and audits (test/operators/operators, test/db/operators)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/operators/invites/:inviteId":
    "the organizer's owner only; another event's invite answers 404 (test/operators/operators, test/db/operators)",
  "PUT /v1/organizers/:organizerId/events/:eventId/operators/:operatorId":
    "the organizer's owner only; quest limits only to the path's event's quests (test/operators/operators, test/db/operators)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/operators/:operatorId":
    "the organizer's owner only; another event's operator answers 404 (test/operators/operators, test/db/operators)",
  "POST /v1/operator-invites/preview":
    "shows only the invite its signed token opens, to a signed-in player; an email invite only to that email's account (test/operators/operators, test/db/operators)",
  "POST /v1/operator-invites/claim":
    "makes only the bearer an operator, once per invite, under a row lock (test/operators/operators, test/db/operators)",
  "GET /v1/me/operator-events": "only the bearer's own assignments (test/operators/operators)",
  "GET /v1/operator/events/:eventId/stations":
    "only an operator of that event, only their own counts; anyone else answers 403 (test/operators/operators, test/db/operators)",
  "POST /v1/events/:eventId/operator/play":
    "enrolls only the bearer, only where they are an operator the owner allows to play (test/operators/operators, test/db/operators)",
  "GET /v1/me/qr": "only the bearer's own code (test/operators/operators)",
  "POST /v1/me/qr/reset":
    "only the bearer's own code (test/operators/operators, test/db/operators)",
  "GET /v1/operator/events/:eventId/desk":
    "only an operator of that event with the hand-over ability, through operator_desk bound to the session; anyone else 403 (test/desk/routes, test/desk/desk)",
  "POST /v1/operator/desk/lookup":
    "only an operator of the body's event with the hand-over ability; names only that event's players, by their current My QR; never a price, score or balance (test/desk/routes, test/desk/desk)",
  "POST /v1/operator/redemptions/:redemptionId/hand-over":
    "only an operator of the redemption's event with the hand-over ability, never their own; every gate in finish_handover under the locks (test/desk/routes, test/desk/desk)",
  "GET /v1/operator/redemptions/:redemptionId":
    "only an operator of the redemption's event; shows only that desk's own offer (test/desk/routes, test/desk/desk)",
  "POST /v1/operator/redemptions/:redemptionId/cancel":
    "only an operator of the redemption's event with the hand-over ability, never their own; the player's balance is not shown (test/desk/routes, test/desk/desk)",
  "POST /v1/redemptions/:redemptionId/collect":
    "only the bearer's own reservation, through start_collect bound to the session; another's answers 404 (test/desk/routes, test/desk/desk)",
  "POST /v1/redemptions/:redemptionId/accept":
    "only the bearer's own reservation, and only a live offer from an operator still allowed to hand over (test/desk/routes, test/desk/desk)",
  "POST /v1/redemptions/:redemptionId/decline":
    "only the bearer's own reservation (test/desk/routes, test/desk/desk)",
  "GET /v1/me/desk-items": "only the bearer's own reservations (test/desk/routes, test/desk/desk)",
  "POST /v1/operator/events/:eventId/desk/find":
    "only an operator of that event with the hand-over ability; exact username or phone among that event's members (never removed ones, never the caller); a ban reads like a flag; 30 finds per operator in 10 minutes; the search never reaches the log (test/desk/routes, test/db/flags, test/flags/routes)",
  "GET /v1/organizers/:organizerId/events/:eventId/flags":
    "members inside their event limit, through event_flags (test/flags/routes, test/db/flags)",
  "GET /v1/organizers/:organizerId/events/:eventId/flags/:flagId":
    "members inside their event limit; a case of another event answers 404; never the install id (test/flags/routes, test/db/flags)",
  "POST /v1/organizers/:organizerId/events/:eventId/flags/:flagId/resolve":
    "members inside their event limit; a case closes once, as points removed only after a removal (test/flags/routes, test/db/flags)",
  "PUT /v1/organizers/:organizerId/events/:eventId/players/:enrollmentId/redeem-pause":
    "the owner only (the scope's hook, then set_redeem_pause) (test/flags/routes, test/db/flags)",
  "PUT /v1/organizers/:organizerId/events/:eventId/flag-hold":
    "the owner only (the scope's hook, then set_flag_hold) (test/flags/routes, test/db/flags)",
  "GET /v1/organizers/:organizerId/events/:eventId/rank-prizes":
    "members inside their event limit; rank_prize under row-level security; another organizer's event answers 404 (test/results/routes, test/db/results)",
  "PUT /v1/organizers/:organizerId/events/:eventId/rank-prizes":
    "members inside their event limit; the switch locks once live; audited (test/results/routes, test/db/results)",
  "POST /v1/organizers/:organizerId/events/:eventId/rank-prizes":
    "members inside their event limit; rank_prize under row-level security and its guard (overlap, live lock, frozen results); audited (test/results/routes, test/db/results)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/rank-prizes/:prizeId":
    "members inside their event limit; a prize of another event answers 404; audited (test/results/routes, test/db/results)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/rank-prizes/:prizeId":
    "members inside their event limit; a prize of another event answers 404; audited (test/results/routes, test/db/results)",
  "GET /v1/organizers/:organizerId/events/:eventId/quest-items":
    "members inside their event limit, through quest_items (award_event_of); another organizer's event answers 404 (test/rewards/quest-items, test/db/quest-items)",
  "POST /v1/organizers/:organizerId/events/:eventId/quest-items":
    "members inside their event limit; quest_item under row-level security and its guard (the desk); audited (test/rewards/quest-items, test/db/quest-items)",
  "PATCH /v1/organizers/:organizerId/events/:eventId/quest-items/:itemId":
    "members inside their event limit; an item of another event answers 404; stock never below the units out; audited (test/rewards/quest-items, test/db/quest-items)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/quest-items/:itemId":
    "members inside their event limit; an item a quest or category gives answers 409; audited (test/rewards/quest-items, test/db/quest-items)",
  "GET /v1/organizers/:organizerId/events/:eventId/quest-items/:itemId/misses":
    "members inside their event limit, through quest_item_misses (award_event_of) (test/rewards/quest-items, test/db/quest-items)",
  "GET /v1/organizers/:organizerId/events/:eventId/results":
    "members inside their event limit, through results_state and results_places (award_event_of) (test/results/routes, test/db/results)",
  "POST /v1/organizers/:organizerId/events/:eventId/results/confirm":
    "the owner only (the scope's hook, then confirm_results), against the places the owner saw; audited (test/results/routes, test/db/results)",
  "POST /v1/organizers/:organizerId/events/:eventId/results/reveal":
    "the owner only (the scope's hook, then reveal_results); audited (test/results/routes, test/db/results)",
  "GET /v1/events/:eventId/results":
    "an active member of that event only, through event_results bound to the session; only the bearer's own prize is named; anyone else reads nothing (test/results/routes, test/db/results)",
  "GET /v1/events/:eventId/rules":
    "an active member of that event only, through event_rules bound to the session; anyone else 404 (test/results/routes, test/db/results)",
  "GET /v1/public/events/:joinCode/rules":
    "one event's official rules by its code, with the join card's visibility (never a draft or archived event); no player data; wrong codes are throttled (test/results/routes, test/db/results)",
  "POST /v1/operator/events/:eventId/find-player":
    "only an operator of that event with the award ability; exact username or phone among that event's members, never the exact status; 30 finds per operator in 10 minutes (test/awards/routes, test/db/awards)",
  "GET /v1/operator/events/:eventId/award":
    "only an operator of that event with the award ability; the event's caps and the caller's own total today (test/awards/routes, test/db/awards)",
  "POST /v1/operator/award":
    "only an operator of the body's event with the award ability, never to themselves, inside the event's caps under a lock on their assignment (test/awards/routes, test/db/awards)",
  "GET /v1/organizers/:organizerId/events/:eventId/players/:enrollmentId/entries":
    "members inside their event limit, through member_ledger; a player of another event answers nothing (test/awards/routes, test/db/awards)",
  "POST /v1/organizers/:organizerId/events/:eventId/players/:enrollmentId/awards":
    "members inside their event limit; an editor inside the event's caps, the owner uncapped (test/awards/routes, test/db/awards)",
  "POST /v1/organizers/:organizerId/events/:eventId/entries/:entryId/remove":
    "members inside their event limit; only a credit entry of that event, once (test/awards/routes, test/db/awards)",
  "GET /v1/organizers/:organizerId/events/:eventId/awards":
    "members inside their event limit, through manual_awards (test/awards/routes, test/db/awards)",
  "PUT /v1/organizers/:organizerId/events/:eventId/award-caps":
    "the owner only (the scope's hook, then set_award_caps) (test/awards/routes, test/db/awards)",
  "POST /v1/organizers/:organizerId/events/:eventId/bulk-awards/preview":
    "members inside their event limit; matches only that event's members (test/awards/routes, test/db/awards)",
  "POST /v1/organizers/:organizerId/events/:eventId/bulk-awards":
    "members inside their event limit; ids outside the event are skipped; an editor inside the per-award cap (test/awards/routes, test/db/awards)",
  "POST /v1/quests/:questId/submit":
    "the calling player's own active enrollment in the quest's event only; guidelines, cap and one pending checked by submit_quest (test/submissions/routes, test/db/submissions)",
  "GET /v1/events/:eventId/submissions/mine":
    "the calling player's own submissions only, through own_submissions; never another player's (test/submissions/routes, test/db/submissions)",
  "GET /v1/operator/events/:eventId/submissions":
    "only an operator of that event with the review ability; pending ones inside their quest limit, never their own (test/submissions/routes, test/db/submissions)",
  "POST /v1/operator/events/:eventId/submissions/:submissionId/review":
    "only an operator of that event with the review ability, inside their quest limit, never their own (test/submissions/routes, test/db/submissions)",
  "GET /v1/organizers/:organizerId/events/:eventId/submissions":
    "members inside their event limit, through event_submissions (test/submissions/routes, test/db/submissions)",
  "POST /v1/organizers/:organizerId/events/:eventId/submissions/:submissionId/review":
    "members inside their event limit; only a submission of that event, once (test/submissions/routes, test/db/submissions)",
  "POST /v1/organizers/:organizerId/events/:eventId/submissions/:submissionId/remove":
    "members inside their event limit; only an approved submission of that event, through remove_award (test/submissions/routes, test/db/submissions)",
  "POST /v1/organizers/:organizerId/events/:eventId/submissions/seen":
    "members inside their event limit; only that event's submissions are marked (test/submissions/routes, test/db/submissions)",
  "POST /v1/events/:eventId/tickets":
    "the calling player's own active enrollment in that event only; the switch, the 30 days, the quest of that event and the caps checked by open_ticket (test/tickets/routes, test/db/tickets)",
  "GET /v1/events/:eventId/tickets/mine":
    "the calling player's own tickets only, through own_tickets; never another player's, never who answered ; 60 a minute per player (test/tickets/routes, test/db/tickets)",
  "GET /v1/me/tickets":
    "the calling player's own tickets in every event, through own_tickets(NULL); never another player's, never who answered ; 60 a minute per player (test/tickets/routes, test/db/tickets)",
  "POST /v1/events/:eventId/tickets/seen":
    "marks only the calling player's own closed tickets of that event ; 60 a minute per player (test/tickets/routes, test/db/tickets)",
  "POST /v1/me/tickets/seen":
    "marks only the calling player's own closed tickets, in any event ; 60 a minute per player (test/tickets/routes, test/db/tickets)",
  "GET /v1/operator/events/:eventId/inbox":
    "only an operator of that event with review or help_desk; pending submissions and open tickets inside their quest limit, never their own ; 60 a minute per operator (test/tickets/routes, test/db/tickets)",
  "GET /v1/operator/events/:eventId/inbox/count":
    "only an operator of that event with review or help_desk; counts by the inbox's own rules ; 60 a minute per operator (test/tickets/routes, test/db/tickets)",
  "GET /v1/operator/events/:eventId/tickets/:ticketId":
    "only an operator of that event with help_desk; an open ticket inside their limit and not their own, or one they answered; never who answered ; 60 a minute per operator (test/tickets/routes, test/db/tickets)",
  "POST /v1/operator/events/:eventId/tickets/:ticketId/answer":
    "only an operator of that event with help_desk, inside their quest limit, never their own; once (test/tickets/routes, test/db/tickets)",
  "GET /v1/organizers/:organizerId/events/:eventId/tickets":
    "members inside their event limit, through event_tickets and event_ticket_counts (test/tickets/routes, test/db/tickets)",
  "POST /v1/organizers/:organizerId/events/:eventId/tickets/:ticketId/answer":
    "members inside their event limit; only a ticket of that event, once; audited without the text (test/tickets/routes, test/db/tickets)",
  "POST /v1/organizers/:organizerId/events/:eventId/tickets/:ticketId/escalate":
    "owners and editors inside their event limit (award_event_of); only an open ticket of that event's queue, once; audited without the note (test/tickets/center, test/db/tickets-center)",
  "POST /v1/me/tickets":
    "the calling player's own account only, active; no event, the caps and the device facts checked by open_platform_ticket (test/tickets/center, test/db/tickets-center)",
  "GET /v1/admin/tickets":
    "active platform admins only (walked below); exactly the tickets with queue = 'questify', the admin checked again (app_admin_id), every read audited per event shown ; 120 a minute per admin (test/tickets/center, test/db/tickets-center)",
  "GET /v1/admin/tickets/counts":
    "active platform admins only (walked below); counts of Questify's queue only ; 120 a minute per admin (test/tickets/center, test/db/tickets-center)",
  "GET /v1/admin/tickets/:ticketId":
    "active platform admins only (walked below); a ticket in Questify's queue only, any other id the same 404; audited with the event's ids ; 120 a minute per admin (test/tickets/center, test/db/tickets-center)",
  "POST /v1/admin/tickets/:ticketId/answer":
    "active platform admins only (walked below); a ticket in Questify's queue only, once; audited without the text ; 120 a minute per admin (test/tickets/center, test/db/tickets-center)",
  "POST /v1/admin/tickets/:ticketId/return":
    "active platform admins only (walked below); an escalated ticket in Questify's queue only; audited without the note ; 120 a minute per admin (test/tickets/center, test/db/tickets-center)",
  "GET /v1/quests/:questId/vote":
    "the calling player's own options and choice, through member_vote; only a quest they may play (test/plays/routes, test/db/vote-quiz)",
  "POST /v1/quests/:questId/vote":
    "the calling player's own active enrollment in the quest's event only; one vote, checked by vote_quest (test/plays/routes, test/db/vote-quiz)",
  "GET /v1/quests/:questId/poll":
    "the calling player's own view of a live poll they may see, through member_poll; counts only when its policy allows, through poll_results, never who voted (test/plays/polls, test/db/live-polls)",
  "GET /v1/events/:eventId/live":
    "the calling player's own live state, through live_state; anyone not an active member gets the same empty answer, naming no event (test/plays/polls, test/db/live-polls)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/send":
    "members inside their event limit; a live poll of that event only, through send_poll (test/plays/polls, test/db/live-polls)",
  "POST /v1/organizers/:organizerId/events/:eventId/quests/:questId/close":
    "members inside their event limit; a live poll of that event only, through close_poll (test/plays/polls, test/db/live-polls)",
  "GET /v1/quests/:questId/quiz":
    "the calling player's own attempt only, through member_quiz; never a right answer before it was answered or closed (test/plays/routes, test/db/vote-quiz)",
  "POST /v1/quests/:questId/quiz/start":
    "the calling player's own attempt in a quest they may play, through quiz_start (test/plays/routes, test/db/vote-quiz)",
  "POST /v1/quests/:questId/quiz/next":
    "the calling player's own attempt only, through quiz_next (test/plays/routes, test/db/vote-quiz)",
  "POST /v1/quests/:questId/quiz/answer":
    "the calling player's own attempt only, one try per question, through quiz_answer (test/plays/routes, test/db/vote-quiz)",
  "POST /v1/steps/:stepId/stamp":
    "the calling player's own active enrollment in the step's event only; the code is bound to the step in the path, then stamp_step checks the rest (test/plays/passport, test/db/passport)",
  "POST /v1/categories/:categoryId/reveal":
    "the calling player's own active enrollment in the category's event only; the code is bound to the category in the path before any read, then reveal_category checks the rest (test/reveal, test/db/categories-hidden)",
  "GET /v1/quests/:questId/passport":
    "the calling player's own view only, through member_passport: the steps and which they stamped; never a step's code (test/plays/passport, test/db/passport)",
  "GET /v1/quests/:questId/survey":
    "the calling player's own view only, through member_survey: the questions and whether they answered; never anyone's answers (test/plays/survey-share, test/db/challenge-survey-share)",
  "POST /v1/quests/:questId/survey":
    "the calling player's own active enrollment in the quest's event only; one response, checked by submit_survey (test/plays/survey-share, test/db/challenge-survey-share)",
  "GET /v1/quests/:questId/share":
    "the calling player's own view only, through member_share; absent while share quests are off (test/plays/survey-share, test/db/challenge-survey-share)",
  "POST /v1/quests/:questId/share":
    "the calling player's own active enrollment in the quest's event only; once, refused while share quests are off, through share_quest (test/plays/survey-share, test/db/challenge-survey-share)",
  "GET /v1/organizers/:organizerId/events/:eventId/quests/:questId/survey":
    "members inside their event limit; results of a survey quest of that event only, names not shown, through survey_summary (test/plays/survey-share, test/db/challenge-survey-share)",
  "GET /v1/organizers/:organizerId/events/:eventId/quests/:questId/votes":
    "members inside their event limit; counts of a vote quest of that event only, never who voted (test/plays/routes, test/db/vote-quiz)",
  "POST /v1/operator/scan/practice":
    "only an operator of the quest's event with the scan ability, inside their quest limit; the real door undone in the database and the transaction always rolled back, so nothing is written; names only that event's players (test/operators/practice, test/db/practice-scan)",
  "GET /v1/operator/events/:eventId/stations/:questId/today":
    "only an operator of that event, a station quest of that event inside their quest limit; counts only ; 60 a minute per operator (test/operators/practice, test/db/practice-scan)",
  "POST /v1/operator/scan":
    "only an operator of the quest's event with the scan ability, inside their quest limit; names only that event's players; never a score or balance (test/operators/operators, test/db/operators)",
  "POST /v1/me/contact/code":
    "starts a change for the bearer only; start_contact_change is bound to the session and never says whether another account has the contact (test/players/contact, test/db/contact-change)",
  "POST /v1/me/contact/verify":
    "changes the bearer's own contact only, through confirm_contact_change bound to the session (test/players/contact, test/db/contact-change)",
  "POST /v1/me/deletion/code":
    "sends a deletion code to the bearer's own contact only, read through own_deletion_contact bound to the session (test/deletion/deletion, test/db/account-deletion)",
  "POST /v1/me/acceptances":
    "records the bearer's own acceptances only, through accept_player_documents bound to the session (test/players/legal, test/db/player-legal)",
  "PATCH /v1/me":
    "the bearer's own avatar and username only; renames go through rename_player, bound to the session (test/players/profile, test/db/usernames)",
  "POST /v1/auth/code":
    "player sign-in; opens a challenge for the contact in the body, the same answer for every contact (test/players/sign-in)",
  "POST /v1/auth/resend": "bound to its own challenge token (test/players/sign-in)",
  "POST /v1/auth/verify":
    "bound to its own challenge token and code; the player comes from the database (test/players/sign-in)",
  "POST /v1/deletion/code":
    "answers the same for any contact and sends the code only to the contact's own phone or email; the code is useless without it (test/deletion/deletion, test/db/account-deletion)",
  "POST /v1/deletion/verify":
    "bound to its own challenge token and code; the player comes from the database (test/deletion/deletion, test/db/account-deletion)",
  "POST /v1/deletion/confirm":
    "bound to the single-use deletion token a right code made; erase_player derives the player from it (test/deletion/deletion, test/db/account-deletion)",
  "POST /v1/auth/signup": "bound to the signup token a verified code made (test/players/sign-in)",
  "POST /v1/auth/refresh": "bound to the refresh token's own family (test/players/sign-in)",
  "POST /v1/auth/logout": "ends only the presented refresh token's family (test/players/sign-in)",
  "GET /v1/organizers/:organizerId/events/:eventId/activation":
    "members of that organizer within their event limit; another organizer's event answers 404 (test/activation/activation)",
  "POST /v1/organizers/:organizerId/events/:eventId/activation":
    "the organizer's owner only (walked below); request_event_activation checks the owner again and audits (test/activation/activation, test/db/activation)",
  "DELETE /v1/organizers/:organizerId/events/:eventId/activation":
    "the organizer's owner only (walked below); withdraw_event_activation checks the owner again (test/activation/activation, test/db/activation)",
  "GET /v1/admin/activation-requests":
    "active platform admins only: anyone else 404 (walked below); every organizer by design (test/activation/activation)",
  "GET /v1/admin/events":
    "active platform admins only (walked below); finds an event by its join code (test/activation/activation)",
  "GET /v1/admin/events/:eventId":
    "active platform admins only (walked below) (test/activation/activation)",
  "POST /v1/admin/events/:eventId/activate":
    "active platform admins only (walked below); activate_event checks the account again (app_admin_id) and audits (test/activation/activation, test/db/activation)",
  "POST /v1/admin/events/:eventId/reject":
    "active platform admins only (walked below); the definer checks again and audits (test/db/activation)",
  "PUT /v1/admin/events/:eventId/limit":
    "active platform admins only (walked below); the definer checks again and audits (test/db/activation)",
  "PUT /v1/admin/events/:eventId/addons/:feature":
    "active platform admins only (walked below); the settings service and the entitlement policy check the admin (test/settings)",
  "DELETE /v1/admin/events/:eventId/addons/:feature":
    "active platform admins only (walked below); the settings service and the entitlement policy check the admin (test/settings)",
};

const PUBLIC_ROUTES = [
  "GET /healthz",
  "GET /readyz",
  "GET /v1/config",
  "GET /v1/public/events",
  "GET /v1/public/events/:joinCode",
  "GET /v1/public/events/:joinCode/quests",
  "GET /v1/public/events/:joinCode/rules",
  "GET /v1/translations",
  "POST /v1/auth/code",
  "POST /v1/auth/logout",
  "POST /v1/auth/refresh",
  "POST /v1/auth/resend",
  "POST /v1/auth/signup",
  "POST /v1/auth/verify",
  "POST /v1/deletion/code",
  "POST /v1/deletion/confirm",
  "POST /v1/deletion/verify",
  "POST /v1/device/pairing",
  "POST /v1/staff/auth/code",
  "POST /v1/staff/auth/password",
  "POST /v1/staff/auth/resend",
  "POST /v1/staff/auth/reset/confirm",
  "POST /v1/staff/auth/reset/request",
  "POST /v1/staff/auth/sign-up",
  "POST /v1/staff/auth/sign-up/code",
  "POST /v1/staff/auth/sign-up/resend",
  "POST /v1/staff/invites/accept-new",
  "POST /v1/staff/invites/inspect",
];

const MISSING = "00000000-0000-4000-8000-000000000000";

/** An error answer without its request id, which differs on every request. */
const shape = (body: string) => {
  const { requestId: _requestId, ...rest } = JSON.parse(body) as Record<string, unknown>;
  return rest;
};

describe.skipIf(TEST_DATABASE_URL === undefined)("route isolation", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const routes = (access?: "public" | "staff" | "member" | "owner" | "admin") =>
    test.app.routeInventory.filter(
      (route) => route.method !== "HEAD" && (access === undefined || route.access === access),
    );

  const call = async (
    route: { method: string; url: string },
    organizerId: string,
    cookie: string,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: route.method as "GET" | "POST" | "PATCH" | "DELETE",
      url: route.url.replace(":organizerId", organizerId).replace(/:[a-zA-Z]+/g, MISSING),
      headers: withSession(cookie),
      ...(route.method === "GET" ? {} : { payload: {} }),
    });

  const sessionIdsOf = async (staffUserId: string): Promise<string[]> =>
    (
      await db.owner.query<{ id: string }>(
        "SELECT id FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL",
        [staffUserId],
      )
    ).rows.map((row) => row.id);

  const stillSignedIn = async (cookie: string) =>
    (await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookie) })).statusCode;

  describe("every route is accounted for", () => {
    it("lists each route with how it keeps callers apart", () => {
      expect(
        routes()
          .map((route) => `${route.method} ${route.url}`)
          .toSorted(),
      ).toEqual(Object.keys(ROUTES).toSorted());
    });

    it("has exactly these public routes and nothing else open", () => {
      expect(
        routes("public")
          .map((route) => `${route.method} ${route.url}`)
          .toSorted(),
      ).toEqual(PUBLIC_ROUTES);
    });

    it("keeps staff routes under /v1/staff, where the session check runs", () => {
      for (const route of routes("staff")) {
        expect(route.url.startsWith("/v1/staff/"), route.url).toBe(true);
      }
    });
  });

  describe("outsider (no session)", () => {
    it("answers 401 with no-store on every staff route", async () => {
      const closed = [
        ...routes("staff"),
        ...routes("member"),
        ...routes("owner"),
        ...routes("admin"),
      ];
      expect(closed.length).toBeGreaterThanOrEqual(4);
      for (const route of closed) {
        const response = await test.app.inject({
          method: route.method as "GET" | "POST" | "DELETE",
          url: route.url.replace(":id", MISSING).replace(":organizerId", MISSING),
          headers: browserHeaders(),
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("cannot tell another organizer's private event from one that does not exist", async () => {
      const hidden = await test.app.inject({ url: `/v1/config?event=${ids.eventB}` });
      const missing = await test.app.inject({ url: `/v1/config?event=${MISSING}` });
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(shape(hidden.body)).toEqual(shape(missing.body));
    });
  });

  describe("one staff member against another", () => {
    let cookieA = "";
    let cookieB = "";
    let staffA = "";
    let staffB = "";

    beforeAll(async () => {
      staffA = await createStaff(db.owner, { email: "owner@najd.test" });
      staffB = await createStaff(db.owner, { email: "owner@tabuk.test" });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
        [ids.orgA, staffA, ids.orgB, staffB],
      );
      cookieA = await signInFully(test, "owner@najd.test");
      cookieB = await signInFully(test, "owner@tabuk.test");
    });

    it("shows A only A's account and organizer", async () => {
      const me = await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookieA) });
      expect(me.statusCode).toBe(200);
      const body = me.json<{ id: string; memberships: { organizerId: string }[] }>();
      expect(body.id).toBe(staffA);
      expect(body.memberships.map((membership) => membership.organizerId)).toEqual([ids.orgA]);
      expect(me.body).not.toContain(staffB);
      expect(me.body).not.toContain(ids.orgB);
    });

    it("lists only A's own sessions", async () => {
      const list = await test.app.inject({
        url: "/v1/staff/sessions",
        headers: withSession(cookieA),
      });
      expect(list.statusCode).toBe(200);
      const listed = list.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id);
      expect(listed.toSorted()).toEqual((await sessionIdsOf(staffA)).toSorted());
      for (const id of await sessionIdsOf(staffB)) {
        expect(list.body).not.toContain(id);
      }
    });

    it("cannot end B's session: 404 like a missing one, and B stays signed in", async () => {
      const [sessionB] = await sessionIdsOf(staffB);
      expect(sessionB).toBeDefined();
      const attempt = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${sessionB}`,
        headers: withSession(cookieA),
      });
      const missing = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${MISSING}`,
        headers: withSession(cookieA),
      });
      expect(attempt.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(shape(attempt.body)).toEqual(shape(missing.body));
      expect(await stillSignedIn(cookieB)).toBe(200);
    });

    it("signing out ends only A's own session", async () => {
      const out = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/sign-out",
        headers: withSession(cookieA),
      });
      expect(out.statusCode).toBe(204);
      expect(await stillSignedIn(cookieA)).toBe(401);
      expect(await stillSignedIn(cookieB)).toBe(200);
    });
  });

  describe("console routes", () => {
    it("keeps every /v1/admin/ route admin-only and answers any other signed-in person 404", async () => {
      await createStaff(db.owner, { email: "not-an-admin@najd.test" });
      await createStaff(db.owner, { email: "retired-admin@questify.test", admin: true });
      const cookie = await signInFully(test, "not-an-admin@najd.test");
      const retired = await signInFully(test, "retired-admin@questify.test");
      await db.owner.query(
        "UPDATE staff_user SET platform_role = 'none' WHERE email = 'retired-admin@questify.test'",
      );
      const consoleRoutes = routes().filter((route) => route.url.startsWith("/v1/admin/"));
      expect(consoleRoutes.length).toBeGreaterThanOrEqual(8);
      for (const route of consoleRoutes) {
        expect(route.access, `${route.method} ${route.url}`).toBe("admin");
        for (const seat of [cookie, retired]) {
          const response = await test.app.inject({
            method: route.method as "GET" | "POST" | "PUT" | "DELETE",
            url: route.url.replace(/:[a-zA-Z]+/g, MISSING),
            headers: withSession(seat, { "idempotency-key": MISSING }),
            ...(route.method === "GET" ? {} : { payload: {} }),
          });
          expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
          expect(response.headers["cache-control"]).toBe("no-store");
        }
      }
    });
  });

  describe("organizer routes", () => {
    let ownerCookie = "";
    let editorCookie = "";
    let strangerCookie = "";

    beforeAll(async () => {
      const ownerId = await createStaff(db.owner, { email: "boss@najd-team.test" });
      const editorId = await createStaff(db.owner, { email: "editor@najd-team.test" });
      const strangerId = await createStaff(db.owner, { email: "boss@tabuk-team.test" });
      const org = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Team Co', 'team-co') RETURNING id",
        )
      ).rows[0]?.id;
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $5, 'editor')",
        [org, ownerId, editorId, ids.orgB, strangerId],
      );
      organizerOfTeam = org ?? "";
      ownerCookie = await signInFully(test, "boss@najd-team.test");
      editorCookie = await signInFully(test, "editor@najd-team.test");
      strangerCookie = await signInFully(test, "boss@tabuk-team.test");
    });

    let organizerOfTeam = "";

    it("declares every route under /v1/organizers as member or owner", () => {
      const organizerRoutes = routes().filter((route) => route.url.startsWith("/v1/organizers/"));
      expect(organizerRoutes.length).toBeGreaterThan(0);
      for (const route of organizerRoutes) {
        expect(["member", "owner"], `${route.method} ${route.url}`).toContain(route.access);
      }
    });

    it("answers a member of another organizer exactly like a missing organizer: 404", async () => {
      for (const route of [...routes("member"), ...routes("owner")]) {
        const other = await call(route, organizerOfTeam, strangerCookie);
        const missing = await call(route, MISSING, strangerCookie);
        expect(other.statusCode, `${route.method} ${route.url}`).toBe(404);
        expect(shape(other.body)).toEqual(shape(missing.body));
        const malformed = await call(route, "not-a-uuid", strangerCookie);
        expect(malformed.statusCode).toBe(404);
      }
    });

    it("refuses an editor every owner route with 403", async () => {
      for (const route of routes("owner")) {
        const response = await call(route, organizerOfTeam, editorCookie);
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
        expect(response.json()).toMatchObject({ code: "owner_only" });
      }
    });

    it("shows the team to its members, owner first, with emails and no other account fields", async () => {
      for (const cookie of [ownerCookie, editorCookie]) {
        const response = await test.app.inject({
          url: `/v1/organizers/${organizerOfTeam}/members`,
          headers: withSession(cookie),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        const body = response.json<{
          members: { email: string; role: string }[];
          invites: unknown[];
        }>();
        expect(body.members.map((member) => [member.email, member.role])).toEqual([
          ["boss@najd-team.test", "owner"],
          ["editor@najd-team.test", "editor"],
        ]);
        expect(response.body).not.toContain("argon2");
        expect(response.body).not.toContain("tabuk");
      }
    });
  });
});
