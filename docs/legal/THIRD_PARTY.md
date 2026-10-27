# Third-party material

Material Questify ships or stores that others made, with its licence and what we changed.

| Material | Where it is used | Source and licence | Changes |
|---|---|---|---|
| Arabic and English word lists for usernames | `username_word`, seeded by `apps/api/migrations/0016_profile_and_usernames.sql` (ADR-119) | "List of Dirty, Naughty, Obscene, and Otherwise Bad Words", Shutterstock and contributors, <https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words>, licensed under CC BY 4.0 (<https://creativecommons.org/licenses/by/4.0/>) | Modified: entries that would block ordinary names or words removed, entries folded (Arabic letter variants, lower case) and reduced to letters, each marked to match a whole word or any part of a username, and a few Arabic forms added. Questify admins edit the lists from then on (FR-1779) |
| English guess list for the daily word game | `data/word-lists/guess-list-en.txt`, imported into `word_guess_list` from the console (T-406d, ADR-327) | SCOWL, the English Speller Database, Kevin Atkinson, <https://wordlist.aspell.net>, an MIT-like permission notice (below, and in `data/word-lists/NOTICE.txt`) | Only the lower-case five-letter words kept (names and abbreviations are capitalized in the source); words marked offensive or vulgar, listed in LDNOOBW, or on our short extra list removed; sorted |
| Arabic guess list for the daily word game | `data/word-lists/guess-list-ar.txt`, imported into `word_guess_list` from the console (T-406d, ADR-327) | Wikidata Lexemes (Arabic), the dump of 2026-10-21, <https://www.wikidata.org>, CC0 1.0 (<https://creativecommons.org/publicdomain/zero/1.0/>) | Lemmas and forms folded to the 33-letter set and `word_norm`, five letters kept, every spelling filed as a proper noun left out, the definite article put before three-letter nouns and adjectives, implausible strings, blocked words and repeats removed; sorted |
| Blocked words for the guess lists | Read by `scripts/build-word-lists.mjs` only; no entry of the list is shipped | LDNOOBW (first row), CC BY 4.0, and the offensive and vulgar marks of the SCOWL source data | Used to decide which guess-list words to leave out |

## Daily word guess lists (T-406d, ADR-327, Q-281)

Checked on 2026-10-27 at the primary source of each licence. Only licences that allow commercial use and redistribution
with at most attribution were accepted (CC0, MIT-like, CC BY); share-alike, non-commercial, copyleft and unclear terms
were not. The daily words themselves are the team's own hand-picked list and come from no source here.

### English: SCOWL (ESDB)

- **Source:** the generator at <https://app.aspell.net/create>, called as
  `http://app.aspell.net/create?diacritic=strip&download=wordlist&encoding=utf-8&format=inline&max_size=80&max_variant=1&spelling=US&spelling=GBs&spelling=GBz&spelling=CA`
  (size 80, American, British "ise" and "ize" and Canadian spellings, common variants, accents stripped; no Australian
  spellings and nothing above size 80, so the extra notices for those do not apply). ESDB revision 1e5b7d3 of
  2026-06-24 (the head of branch `v2` of <https://github.com/en-wl/wordlist>). SHA-256 of the download:
  `d96e88c6a3a6d99cff904c8a09b1a0c81fafd8c6e3ec3482e33c5a6f8524cc8c`.
- **Licence, read in the `Copyright` file of the repository and in the header of the generated list:** "Permission to
  use, copy, modify, distribute, and sell any part of the English Speller Database (ESDB, previously known as SCOWLv2),
  or word lists created from it, is hereby granted without fee, provided that the above copyright notice appears in all
  copies and that both the above copyright notice and this notice appear in supporting documentation." For a speller
  dictionary that is not Australian English the file says "no additional copyright applies and including the notice
  before the === is sufficient"; the Australian notice applies to lists using the `D` spelling and the UKACD notice to
  generated lists above size 80, neither of which this list is. The notice is kept in `data/word-lists/NOTICE.txt` and
  below.
- **Also read:** `data/scowl-pre.txt` of the same revision (SHA-256
  `a5fe3f11682a6ab9d31f2ea2a185833b1a01be7af83409c671bd0756a870f6c7`), only to find the words its entries mark
  `offensive-1`, `offensive-2`, `vulgar-1` or `vulgar-3`, which the guess list leaves out. Nothing from it ships.
- **Attribution text:** "English words: SCOWL / English Speller Database, Copyright 2000-2026 by Kevin Atkinson,
  <https://wordlist.aspell.net>."

### Arabic: Wikidata Lexemes

- **Source:** the Wikidata lexeme dump <https://dumps.wikimedia.org/wikidatawiki/entities/latest-lexemes.json.gz>, file
  dated 2026-10-21 (the same file as <https://dumps.wikimedia.org/wikidatawiki/entities/20261021/wikidata-20261021-lexemes.json.gz>), 655,273,999 bytes, SHA-256
  `85ebe293f2357f69776fd06edc4fb4c23f26403f3489b8ff9e1014322dc3f4c2`. Its 85,930 lexemes of language Q13955 (Arabic)
  carry about 1.8 million forms.
- **Licence, read at <https://www.wikidata.org/wiki/Wikidata:Licensing> and <https://dumps.wikimedia.org/legal.html>:**
  "All structured data (i.e. the main, Property, Lexeme, and EntitySchema namespaces) is released into the public domain
  under Creative Commons Zero." and, for the dumps, "Copyrights of structured data in the main, Property, Lexeme, and
  EntitySchema namespaces are waived using the Creative Commons Zero (CC0) public domain dedication."
- **Attribution text:** none required; "Arabic words: Wikidata Lexemes, CC0 1.0, <https://www.wikidata.org>."
- **What the list is:** the lemmas and every form of the Arabic lexemes (nouns, adjectives, bot-generated verb
  conjugations and the rest), so it holds the inflected forms a player types and also some forms that are grammatical
  but rare. Every spelling of a lexeme of the category proper noun (Q147276) is left out, also where another lexeme
  spells a common word the same way (about 30 words); a name filed as a plain noun can still be in it.

### Blocked words: LDNOOBW

- <https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words>, files `en` (SHA-256
  `af851ecef1d5f212caba17339b12ac39cc2fef7d78c74876f67237644fcee8bd`) and `ar` (SHA-256
  `23dbd9c55257bf2a4965f46664dc7eac04b61ff4eb3571e41f7e964c7c3ed96b`). Licence file read: "Attribution 4.0
  International" (CC BY 4.0); the README: "This work is licensed under a Creative Commons Attribution 4.0
  International License."
- Used only to drop words from the guess lists. Attribution text as in the first row of the table.

### Rebuilding and checking

`node scripts/build-word-lists.mjs en <scowl list> <scowl-pre.txt> <ldnoobw en> data/word-lists/guess-list-en.txt` and
`node scripts/build-word-lists.mjs ar <latest-lexemes.json.gz> <ldnoobw ar> data/word-lists/guess-list-ar.txt` rebuild
the files from the downloads (each download in its own folder, read as text only). Built from the files above, the
outputs have SHA-256 `964a47ff02f05903f3a8b2d1a60bf4936274905aa2526dbf785ca472fd2770d4` (English, 8,863 words) and
`441ea0b05edcf3ed3f2f2fd2bc06c2e96f4f8c78b30e67d15004fcb99e4c77c5` (Arabic, 119,023 words).
`apps/web/src/lib/word-list-files.test.ts` checks the format of both files and that the console import takes them whole.

### The SCOWL notice (kept with every copy of the English list)

> Copyright 2000-2026 by Kevin Atkinson
>
> Permission to use, copy, modify, distribute, and sell any part of the English Speller Database (ESDB, previously
> known as SCOWLv2), or word lists created from it, is hereby granted without fee, provided that the above copyright
> notice appears in all copies and that both the above copyright notice and this notice appear in supporting
> documentation. Kevin Atkinson makes no representations about the suitability of this database for any purpose. It is
> provided "as is" without express or implied warranty.
>
> ESDB is derived from many sources, most of which are in the Public Domain. Data from the Corpus of Contemporary
> American English (COCA) was also used.
>
> All data from COCA comes from 3-gram data that is not freely available; however, the usage is within the rights given
> by the NDA that was signed when purchasing the data. More information on COCA is available at
> https://www.english-corpora.org/coca/.
>
> The primary source of words for ESDB comes from 12dicts and ENABLE2K. Both are in the Public Domain, but Alan Beale
> <biljir@pobox.com> deserves special credit as he is the author of 12dicts and a major contributor to ENABLE2K. In
> addition, he gave me an incredible amount of feedback and created a number of special lists in order to help improve
> the overall quality of ESDB.

### Sources looked at and not used

| Source | Licence found at its primary source | Why not |
|---|---|---|
| Leipzig Corpora Collection (Wortschatz Leipzig) word lists, English and Arabic | <https://wortschatz.uni-leipzig.de/en/usage>: "The text corpora offered for download are made available under the Creative Commons licence CC BY"; the same text says "commercial use of the data" is "prohibited without the written consent of the project management" | Two statements that disagree on commercial use: unclear terms |
| FrequencyWords (hermitdave), from OpenSubtitles | <https://github.com/hermitdave/FrequencyWords>: "MIT License for code. CC-by-sa-4.0 for content." | Share-alike would reach our data files |
| Ayaspell Arabic dictionary (hunspell-ar) | <https://github.com/linuxscout/ayaspell>: "GPL/LGPL/MPL tri-license" | Copyleft |
| Snowball Arabic spelling word list | <https://github.com/snowballstem/snowball-data/tree/master/arabic>: "licensed under the GPLv3+" | Copyleft |
| Standard Arabic UKC Lexicon | <https://datascientiafoundation.github.io/LiveLanguage/datasets/arb-ukc-lexicon-/>: "Creative Commons Attribution NonCommercial ShareAlike" | Non-commercial and share-alike |
| SCOWL sizes above 80 | Same `Copyright` file: for a list above size 80 the UKACD notice must be "prominently displayed" and its text "included verbatim" | More than an attribution line; size 80 is enough for guesses |
