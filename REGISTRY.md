# Chapter registry — column reference (design 2a)

`chapter.js` builds each page from one row of the published registry sheet, matched
by `ChapterCode`. Every column below is read with `row['<Column>']`, trimmed.
**All new columns are optional** — the page renders complete without any of them.

## Existing columns (already in the sheet)

| Column | Used for |
|---|---|
| `ChapterCode` | Row lookup (matches `CNL_SETTINGS.chapterCode`) |
| `ChapterName` | Masthead H1, footer |
| `Twitter` `Instagram` `BlueSky` `Facebook` `Email` `Slack` `WhatsApp` `GroupMe` `Discord` | Social pill in the top bar (only non-empty ones render, in that order) |
| `EveryAction Link` | No longer read — the join form is the Action Network chapter form, routed by `ChapterCode` through signup.cnlhq.org (see `cnl-signup-worker/src/chapters.ts`) |
| `Website Category` | Not read by chapter.js (events come from the Luma feed keyed by `ChapterCode`; `CNL_SETTINGS.category` is legacy) |
| `City`, `State` | Fallback for the region kicker when `Region` is empty |
| `Timezone` | IANA zone (e.g. `America/New_York`) — Luma events render in the event's own zone; the zone label shows only when it differs from this |

## New columns to add (all optional, per-chapter customization)

| Column | Limit | Renders as |
|---|---|---|
| `Accent` | one of `brick` `marine` `harvest` `plum` `slate` | Accent color (kicker, drop cap, day numbers, section tag, meta icons, form shadow, submit, input focus, checkbox). Empty/unknown → brick. |
| `Tagline` | ≤ 60 chars | Italic line under the chapter name |
| `About` | ≤ 280 chars | Lead paragraph with drop cap |
| `Meeting` | ≤ 60 chars | "MEETS …" in the masthead meta row (empty → "Meetups every month") |
| `PhotoURL` | landscape image URL | Framed photo card with brick offset shadow |
| `PhotoCaption` | short | Italic caption under the photo |
| `Link1Label` / `Link1URL` … `Link4Label` / `Link4URL` | ≤ 4 links | "Chapter links" pill buttons (a link needs both label and URL) |
| `Officer1Name` / `Officer1Role` … `Officer4Name` / `Officer4Role` | ≤ 4 people | "Chapter officers" dotted-leader list |

Notes:
- Character limits are conventions for editors, not enforced by code — keep to them so layouts stay tidy.
- URLs without a scheme get `https://` prefixed; bare email addresses become `mailto:`.
- The accent's `harvest` and `slate` use darkened text variants for contrast on cream; that mapping lives in `ACCENTS` in chapter.js.
