# minty-prices

The shared price data for **Minty TCG Portfolio Tracker**. A scheduled GitHub job copies TCGplayer's market
prices from [TCGCSV](https://tcgcsv.com) once a day and keeps their history, so the app never has to call TCGCSV
itself (TCGCSV asks user-facing apps not to).

Prices: TCGplayer market prices via TCGCSV. Nothing here is estimated.

## What the job does

- **Every hour** it checks TCGCSV's `last-updated.txt`. Only when TCGCSV has copied new prices (once a day) does it
  read each set of Minty's games once: the sets list, the product list of new or changed sets, and the prices.
  That is about 3,500 requests a day, under TCGCSV's limit of 10,000, with a pause between requests.
- **Once only** it reads TCGCSV's price archive (every day from 8 February 2024), a batch per run. Each archive is
  downloaded one time and never again, as TCGCSV asks.

## Files (release downloads)

| release | file | what |
|---|---|---|
| `prices` | `categories.json` | TCGplayer's list of games (categories) |
| `prices` | `prices-<category>.json.gz` | a TCGplayer category (game): its sets, products and today's market prices |
| `prices` | `releases.json` | sets coming out in the next 100 days and out in the last 14: dates (the makers' own where they publish them), products, one trusted eBay link each |
| `prices` | `news.json` | card-game headlines from news sites, last 30 days: headline, date, link and site only |
| `prices` | `deals.json`, `listings.json.gz` | eBay deals and listings (eBay API), at most 6 hours old |
| `prices` | `graded.json.gz`, `epid.json.gz` | graded prices of cards in use, eBay catalog numbers |
| `prices` | `rates.json.gz`, `grading.json` | exchange rates; grading companies' services and fees |
| `history` | `index.json` | which history file holds each set, and the dates covered |
| `history` | `h-<category>-<n>.json.gz` | daily market price history of a bunch of sets |
| `state` | | the job's own working copy — not for the app |

`status.json` in this repository shows the last update.

## Format

`prices-<category>.json.gz`: `{ cat, updated, groups: [{groupId, name, abbreviation, publishedOn, modifiedOn}],
products: { groupId: [[productId, name, number, rarity, imageUrl, isCard]] }, prices: { groupId: { productId: { subType: dollars|null } } }, missing: [groupId] }`

`h-<category>-<n>.json.gz`: `{ cat, start, series: { "productId|subType": [firstDay, firstPriceCents, change, change, …] } }` —
days are counted from `start`; each later entry is the change in cents from the last price, or `null` for a day with no price.

## Before every push
Run `cp tools/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push` once per clone: every push then runs `node build/test.js` first and is stopped if a check fails (a failing check makes the hourly job skip Read prices).
