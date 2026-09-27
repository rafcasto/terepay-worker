# Historical applications — what to give the trainer console

One ZIP file. Inside it, one folder per application, named with the application ID, plus a CSV at the top
level with the declared figures and what actually happened. Upload it on the **Cases** tab → *Batch import*.

```
historical.zip
├── applications.csv                 ← one row per application (template: /api/batch/template.csv)
├── LN-2024-0001/
│   ├── statement-anz-jan.pdf        ← every bank statement you had at decision time (all accounts, all months)
│   ├── statement-anz-feb.pdf
│   ├── payslip-1.pdf                ← payslips, if any were supplied
│   └── history.txt                  ← TerePay's own notes on prior loans, if any (optional)
├── LN-2024-0002/
│   └── ...
```

## Files inside each folder

| Document | Accepted | How it is recognised | What it feeds |
|---|---|---|---|
| Bank statement | PDF (text, not scanned), TXT, CSV export | any file that parses to ≥ 10 transactions | every expense metric, observed income, balance history |
| Payslip | PDF, TXT | "payslip / payroll / earnings" in the name, or payslip vocabulary in the text (PAYE, KiwiSaver, gross, net, pay period) | net pay per period → monthly; reconciled against statement credits and declared income |
| Prior-loan / credit-history note | PDF, TXT | "history / notes / credit / prior" in the name, or anything left over | Borrower Behaviour Scorecard ticks (each tick must be backed by words in the note) |

File names are free-form; the content decides. Scanned (image-only) PDFs come through empty and are flagged
`unreadable` — run them through OCR first or skip them. Redaction is fine: the analysis needs dates,
descriptions, amounts and balances, not names or account numbers.

## `applications.csv`

| Column | Required | Notes |
|---|---|---|
| `application_id` | yes | must equal the folder name (case-insensitive; spaces/underscores become `-`) |
| `applicant_name` | no | display only |
| `application_date` | no | `YYYY-MM-DD` |
| `loan_amount`, `interest_rate` | recommended | as applied for; `interest_rate` is **% per annum** (TerePay: `49`), not the ~4.74% total interest over the 8-week term |
| `income`, `expenses`, `existing_debt` | recommended | **monthly** figures as declared by the applicant on the form — this is what the engine tests the statements against |
| `loan_purpose` | recommended | free text; "medical / hospital / surgery / dental" triggers the medical-purpose rules |
| `decision_made` | recommended | `approved` / `conditional` / `declined` — what TerePay actually did |
| `decision_by` | no | officer initials |
| `outcome` | **the point of the exercise** | `repaid`, `repaid_late`, `arrears`, `default`, `written_off`, `current`, `declined`. Synonyms are understood ("paid in full", "in arrears", "write off"). |
| `max_days_late` | recommended | worst days-past-due on the loan; `0` if never late |
| `outcome_notes` | no | free text |
| `behaviour_*` (9 columns) | if you have them | `true` / `false` / blank. Keys: `paid_previous_loan_early`, `paid_on_time_consistently`, `communicates_proactively`, `missed_payments_before`, `existing_defaults`, `write_off_history`, `requests_bigger_loan_too_fast`, `provides_multiple_excuses`, `avoids_communication`. When present these are used as the authoritative scorecard instead of reading the history note. |

Column names are matched loosely (`amount`, `purpose`, `status`, `days_late`, `dpd` all work). A folder without a
CSV row is still imported (you can type the figures in later); a CSV row without a folder only updates a case
that already exists.

Instead of the CSV you can drop an `application.json` with the same keys inside each folder.

## What you get back

- **Cases** — every application parsed and scored by the rules engine (no LLM involved, so it is instant), with
  payslip status (`verified` / `mismatch` / `declared_overstated` / `unreadable`) and the outcome you supplied.
  Parsing gaps ("85 of 120 dated lines") mean a bank format the parser has not seen — send me the ID.
- **Backtest** — bad rate (arrears / default / written off) by engine tier, by engine recommendation, by
  TerePay's own decision, and per trigger, plus the two lists that matter: loans the engine would have approved
  that went bad, and loans it would have declined that repaid on time. That is what calibrates `scoring.js`.
- **Labels** — once a credit officer writes the 40–80-word note for a real case, it goes into the fine-tuning
  set at 3× weight.

## Minimum useful set

- 30+ funded loans with a known outcome, ideally ≥ 10 that went bad, across at least two banks.
- Declared income and expenses for each (without them the affordability checks cannot run).
- Whatever payslips you actually held at decision time — do not add ones obtained later.
