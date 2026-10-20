# Third-party material

Material Questify ships or stores that others made, with its licence and what we changed.

| Material | Where it is used | Source and licence | Changes |
|---|---|---|---|
| Arabic and English word lists for usernames | `username_word`, seeded by `apps/api/migrations/0016_profile_and_usernames.sql` (ADR-119) | "List of Dirty, Naughty, Obscene, and Otherwise Bad Words", Shutterstock and contributors, <https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words>, licensed under CC BY 4.0 (<https://creativecommons.org/licenses/by/4.0/>) | Modified: entries that would block ordinary names or words removed, entries folded (Arabic letter variants, lower case) and reduced to letters, each marked to match a whole word or any part of a username, and a few Arabic forms added. Questify admins edit the lists from then on (FR-1779) |
