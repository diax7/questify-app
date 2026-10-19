# Wallet passes (Apple Wallet and Google Wallet): what is possible

> Researched 2026-10-17 from Apple's and Google's developer documentation. Every claim below is
> from those sources unless marked `[belief]`. Planning input for the Wallet decision.

## Summary

Both wallets are separate systems with separate integrations. A pass can carry a QR code and live
fields such as points, level and rank, and it can be updated after it is added. The important
difference for Questify: **Google Wallet supports rotating (changing) barcodes; Apple Wallet does
not.** Questify's My QR rotates every 30 seconds (ADR-040), so the two wallets cannot hold it the
same way.

## Side by side

| Question | Apple Wallet | Google Wallet |
|---|---|---|
| What is a pass | A signed `.pkpass` file | A class (the design, shared) plus an object per person |
| What we need | A Pass Type ID certificate from the Apple Developer account; our server signs each pass | A Google Wallet issuer account; our server calls the API |
| How the user adds it | Link or button from the web, email, or the app; it syncs to all of the user's devices through iCloud | "Add to Google Wallet" button from the web or the app |
| QR code | Yes (QR, PDF417, Aztec, Code 128) | Yes |
| **Rotating QR** | **No.** Apple's own forum answer: dynamic or rotating codes are not supported; the code can be changed by a pass update, but updates are not guaranteed, and users can opt out | **Yes**, a time-based one-time code, with a configurable period (Google's example uses 3 seconds) and a secret key per pass |
| Show points, level, rank | Yes, as fields | Yes (loyalty pass has a points field; generic pass has text modules) |
| Update after adding | Any field except the serial number and pass type ID. Our server sends an empty push, the phone asks our server for the new pass. Delivery is not guaranteed; the user can pull to refresh | `update` replaces the whole object, `patch` changes chosen fields. A class change updates everyone's pass at once |
| Alert when a field changes | A change message can be shown on the lock screen (meant for time-sensitive changes only) | Notifications on update, with limits |
| Lock-screen relevance | A date or location can make the pass appear on the lock screen (handled by the phone, not our app) | Locations and validity times |
| NFC | Possible, but needs a special Apple NFC entitlement | "Smart Tap" works only with certified terminals |
| Branding | Logo, colors and images are inside each pass, so each event can look different | Logo, colors and images are in the class, so one class per event allows a different look per event |
| Works without our app installed | Yes | Yes |

## What this means for Questify

1. **Identity code.** On iPhone the wallet pass can only carry a fixed code (or one our server
   changes through updates that are not guaranteed). A fixed code can be screenshotted, so it
   cannot replace the rotating My QR for anything that needs proof of presence (staffed
   quests, ADR-040). On Android the rotating code works.
2. **Truth stays on our server.** Apple's guidance is that the pass is a copy; the barcode is only
   a lookup key. A balance shown on a pass can be stale.
3. **Data location.** A pass (username, points, rank) is stored in the user's iCloud or Google
   account and sent through Apple's and Google's servers. This sits uneasily with "personal data
   stays in Saudi Arabia" (ADR-070). The data would be minimal, and the player chooses to add the
   pass, but it needs counsel's view (Q-043) and a line on the join card or in the privacy policy.
4. **No new account needed.** A pass can be added from the event web page without installing the
   app. That could soften the install-friction risk in `BUSINESS_MODEL.md`: a player could
   identify themselves for operator-scanned quests and prize pickup with only the pass `[belief]`.
   Quests that need the player's camera still need the app.
5. **Effort.** Two separate integrations: a pass-signing and update service with Apple push for
   Apple; an API integration with an issuer account for Google. Both depend on accounts that
   exist already (Apple Developer, Google).
6. **Store rules `[not verified]`.** Apple expects passes to be useful without the app and not to
   duplicate it. Whether a pass branded with an organizer's logo is allowed was not checked
   against Apple's guidelines (see PD-30 for the app icon rule).

## Sources

- Apple: Wallet Developer Guide "Updating a Pass"; "Adding a Web Service to Update Passes";
  "Getting Started with Apple Wallet"; "Pass Design and Creation"; "Create Wallet identifiers and
  certificates"; WWDC26 "What's new in Wallet"; Apple Developer Forums thread 748463 (rotating
  codes).
- Google: Google Wallet developer docs for Generic and Loyalty passes ("Update Passes Classes and
  Passes Objects", "Rotating Barcodes", "genericobject", "loyaltyobject", Smart Tap configuration).
