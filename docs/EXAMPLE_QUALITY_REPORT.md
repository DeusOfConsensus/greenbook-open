# Example data-quality report

> **Synthetic data.** Generated from the invented fixtures in `fixtures/synthetic/`, with defects planted on purpose, so you can see the shape of the report. It says nothing about the real Greenbook. Regenerate: `greenbook-open quality --snapshot 1 --as-of 2026-10-15`.

Measured on snapshot #1 (taken 2026-09-01T06:00:00Z, source `file:snapshot-2026-09-01.json`, 300 records, content hash `43e1e750da713d10…`). Expiry checks evaluated as of 2026-10-15. Regenerate with `greenbook-open quality --write-readme`.

| Check | Result |
|---|---|
| Product IDs in range 1,000–1,341 | 300 present, **42 missing from the public list** |
| Duplicate product IDs in the source | 0 |
| Registration numbers missing | 0 (0.0%) |
| Registration numbers shared by more than one product | **5 numbers cover 10 products**; largest group `T2-1100` has 2 |
| Approval date missing / unparseable / placeholder | 0 / 1 / 1 |
| Expiry date missing / unparseable / placeholder | 0 / 0 / 0 |
| Expiry before approval | 1 |
| Status "active" but expiry date already passed | 46 |
| Status values not recognised by the normaliser | `Under Review` (1) |
| Records with no parsed ingredient | 0 |
| Strength text that could not be parsed | 1 of 300 (0.3%) |
| Records with an ATC code / missing / invalid | 283 / 17 / 1 |
| Manufacturer missing / applicant missing | 0 / 0 |
| Manufacturer names with several spellings | 3 |

Registration number formats seen (A = letter, 9 = digit): `A9-9999` ×300.

Most common unparsed strengths: `as directed`.

