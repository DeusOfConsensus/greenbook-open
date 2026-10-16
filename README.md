# Greenbook Open

**Open, versioned data and API for the NAFDAC Greenbook, with a bulk registration checker.**

Independent project. **Not affiliated with, endorsed by, or operated by NAFDAC.** The Greenbook is NAFDAC's public register of approved products; this project keeps dated copies of it so you can search it, see what changed, and check a stock list against it.

> **Status: v0.1, built and tested on synthetic data.** Everything below works end to end on the included synthetic snapshots, on both embedded Postgres and real Postgres 16 (92 tests). The one piece **not yet verified against the live site** is the fetcher, because it was written without network access to greenbook.nafdac.gov.ng. Run `greenbook-open probe` first; see [Before your first fetch](#before-your-first-fetch).

## Data quality

The report below is generated from a real snapshot by `greenbook-open quality --write-readme`. It is the first thing to produce once you have fetched.

<!-- QUALITY:START -->

> **Pending first real snapshot.** Nothing in this section has been measured by this project yet.
>
> A third-party scraper's author reports the following for September 2026, **not verified here**: about 9,000 records; 266 registration numbers shared by 544 products; about 3,500 product IDs missing from the public list; about 440 records carrying a data-quality note. Treat these as hypotheses. The generated report will confirm or correct each one.
>
> To see the shape of the report, read [docs/EXAMPLE_QUALITY_REPORT.md](docs/EXAMPLE_QUALITY_REPORT.md) (synthetic data).

<!-- QUALITY:END -->

## Quick start

Needs Node 22 or newer. No database setup is required: by default it uses an embedded Postgres (PGlite) stored in `./data`.

```bash
npm install && npm run build

# Load the three synthetic snapshots (invented data, planted defects)
for s in 2026-09-01 2026-10-01 2026-10-15; do
  node dist/cli.js ingest fixtures/synthetic/snapshot-$s.json --taken-at ${s}T06:00:00Z
done

node dist/cli.js search --ingredient artemether,lumefantrine --limit 3
node dist/cli.js diff 2026-10-01 latest
node dist/cli.js check fixtures/synthetic/stock.csv --as-of 2026-10-15 -o checked.csv
node dist/cli.js quality --snapshot 1
node dist/cli.js verify
node dist/cli.js serve        # REST API on http://127.0.0.1:3000
```

Two binaries are installed: `greenbook-open` and the short alias `gbo`.

For real Postgres set `DATABASE_URL=postgres://user:pass@host:5432/db` (`docker compose up -d` starts one on port 5433). The same SQL runs on both.

## Commands

| Command | What it does |
|---|---|
| `probe` | Fetch 3 rows from the live Greenbook and show raw and normalised forms. **Run this first.** |
| `fetch` | Fetch the whole register slowly and store it as a new snapshot |
| `ingest <file>` | Store a snapshot from `.json`, `.ndjson` or `.csv` |
| `snapshots` | List stored snapshots with their content hashes |
| `search` | `-i` ingredient, `-m` manufacturer, `-a` ATC code or prefix, `-s` status, `-r` reg no, `-q` free text |
| `show <id>` | One product with its raw record and its history across snapshots |
| `diff <from> [to]` | Added, removed, status changes, field changes, newly expired by date |
| `check <stock.csv>` | Flag unregistered, inactive, expired or mismatched products in a stock list |
| `quality` | Data-quality report; `--write-readme` injects it above |
| `verify` | Recompute every hash from stored data; non-zero exit on any mismatch |
| `serve` | Read-only REST API |
| `renormalise` | Rebuild normalised columns from stored raw records after a parser change |

Snapshot references accept `latest`, a snapshot id, or a date (`2026-10-01` means "the register as of the end of that day").

## The checker

`check stock.csv` finds columns by header (`NAFDAC Reg No`, `NRN`, `Product Name`, `Item Description`, `Manufacturer`, ...) or by `--reg-col`, `--name-col` and friends. Comma, semicolon, tab and pipe delimiters and a BOM are handled. It writes your original columns back with `gbo_*` verdict columns appended, and exits non-zero when any row fails (`--fail-on warn|never` to change).

| Verdict | Meaning | Severity |
|---|---|---|
| `ok` | Registered and currently usable | pass, or warn if expiring within 60 days, shared number, or other soft concern |
| `expired` | On the register but past its expiry date, or marked expired | fail |
| `inactive` | Marked inactive, suspended, withdrawn or cancelled | fail |
| `unregistered` | Registration number not on the register (near-miss numbers are suggested) | fail |
| `mismatch` | The number exists but belongs to a clearly different product | fail |
| `ambiguous` | The number is shared by several products and the row cannot choose between them | warn |
| `unverifiable` | No number and no confident name match | warn |

Rows matched only by name are never a clean pass. The checker is a screening aid: it tells you what the register says, and it can be wrong at the margins. It is not a legal determination of whether a product may be sold.

Real output on the synthetic sample:

```
Checked 12 rows against snapshot #3 (2026-10-15T06:00:00Z), expiry as of 2026-10-15.
  pass 2   warn 5   FAIL 5

  row 3    INACTIVE     T8-1205     LEXTANIN 500 TABLETS     register_status_Inactive
  row 4    EXPIRED      T4-1210     DRAFENEX 500 TABLETS     expired_on_2026-01-14
  row 6    UNREGISTERED T9-9999     Phantomex 100 Tablets    reg_no_not_on_register
  row 7    UNREGISTERED T3-1201     NORTANEX 500 TABLETS     reg_no_not_on_register; near_reg_no_found
  row 8    MISMATCH     T3-1200     Totally Different Syrup  reg_no_belongs_to_a_different_product
```

## REST API

Read-only, CORS open. Pagination: `limit` (max 200) and `offset`. Every endpoint that reads a snapshot accepts `snapshot=latest|<id>|<YYYY-MM-DD>`.

| Endpoint | Returns |
|---|---|
| `GET /v1/snapshots` | All snapshots with record counts and content hashes |
| `GET /v1/products` | Search: `q`, `ingredient`, `manufacturer`, `atc`, `status`, `reg_no`, `dosage_form`, `category` |
| `GET /v1/products/:id` | One product (`include_raw=true` adds the raw record) |
| `GET /v1/products/:id/history` | Distinct versions of a product across snapshots |
| `GET /v1/registrations/:regNo` | Every product on a registration number; `shared: true` when more than one |
| `GET /v1/diff?from=&to=` | Differences between two snapshots |
| `GET /v1/quality` | The data-quality report as JSON |
| `POST /v1/check` | Bulk check: JSON `{items:[{reg_no, product_name, ...}]}` or a raw `text/csv` body (up to 5,000 rows) |

`:id` is the **product id**, not the registration number. Registration numbers are not unique in the Greenbook, which is why `/v1/registrations/:regNo` returns a list.

## How snapshots work

- A snapshot is the whole register at a moment. Records are **content-addressed**: a record's hash is the SHA-256 of its product id and cleaned raw fields. An unchanged product costs no new rows when you take another snapshot, so a daily snapshot of ~9,000 records stores only what changed.
- A snapshot's **content hash** is the SHA-256 of its sorted `product_id TAB record_hash LF` lines. It is one value that identifies exactly what the register said, and it is deterministic: the same data in a fresh database gives the same hash (tested).
- The raw record is stored beside the normalised columns. When a parser improves, `renormalise` rebuilds the columns from raw without refetching.
- Diffs are a join on product id between two snapshots, plus a date-driven "newly expired" list (a product can expire without the register changing at all).

What is parsed: ingredients are split and reduced to base names (`Amoxicillin (as trihydrate) BP` becomes `amoxicillin`, the original text is kept); strengths become structured components (`250mg/5ml` is 250 mg per 5 ml; `80mg; 480mg` is two components); dates in ISO, day-first numeric, and `5 Mar 2025` styles become ISO dates, with placeholders like `0000-00-00` reported rather than guessed at; ATC codes are validated; statuses are mapped to a small set. Anything unparseable is recorded in a per-record `issues` list that feeds the quality report. Field-name mappings live in one place: `ALIASES` in `src/normalise/index.ts`.

## Before your first fetch

What was found on 15 October 2026, via a fetch tool, not from the machine this project was built on:

- `greenbook.nafdac.gov.ng/robots.txt` returned `User-agent: *` with an empty `Disallow:`, i.e. no paths blocked.
- The footer reads "© NAFDAC 2025. All rights reserved." and no terms of use for automated access were found.

**Check both yourself before scraping.** Then:

1. Run `greenbook-open probe`. It requests three rows and prints the raw fields and how they normalise. The fetcher follows the public description of how the page loads its table (a jQuery DataTables `GET` to the site root with `X-Requested-With: XMLHttpRequest`, paged by `start` and `length`). That has not been confirmed against the live site, so verify the response shape. If a field you expect comes back null, add its real name to `ALIASES`.
2. Run `greenbook-open fetch`. The client waits at least 2 seconds between requests (1 second is a hard floor that configuration cannot go below), identifies itself as `greenbook-open/<version> (+<repo url>)`, reads `robots.txt` once and honours `Disallow` and `Crawl-delay`, and backs off on 429 and 5xx. The full register is about nine requests at 1,000 rows each.
3. Free-text contact fields (email, phone, address, contact person) are **never stored**: they are dropped at ingest, and email addresses inside other text are redacted.
4. A failed or partial fetch cannot become a snapshot. An empty result, a result shorter than the source reports, or one under 80% of the previous snapshot's size is refused unless you pass `--allow-partial` or `--force`, and a write is all-or-nothing.

## Proving what the register said

Each snapshot has a content hash and `verify` recomputes all of them from the stored data, so any edit to a stored record, or to which records a snapshot contains, is detected. `verify` proves the database is self-consistent. It does not prove what NAFDAC published; for that you need the hash on record somewhere independent and dated. Not built yet, and the natural next step: publish `snapshots --json` hashes as a signed git tag per snapshot, or anchor them on-chain.

## Development

```bash
npm test                      # 92 tests on embedded Postgres (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # same tests, real Postgres
npm run typecheck && npm run build
npm run fixtures              # regenerate the synthetic data
```

Layout: `src/normalise` (parsers, pure functions), `src/fetch` (polite client, sources), `src/snapshot` (ingest, repo, diff, verify), `src/check` (matching and CSV), `src/quality`, `src/api`, `src/cli.ts`, `migrations/`.

## Roadmap

- Alert tracker: extract product, batch and date from NAFDAC counterfeit alerts and link them to Greenbook records.
- Published, signed snapshot hashes.
- Known limits: the checker's name matching is character-based, not ingredient-aware beyond a mismatch guard; only the Greenbook table fields are captured (no SmPC documents).

## Licence

MIT, see [LICENSE](LICENSE). Code only; see the note on data above.
