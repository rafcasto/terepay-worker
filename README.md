# TerePay Credit Assessment Agent (Raspberry Pi 5 + n8n + local LLM)

Local, auditable credit assessment. A queue message names an application; n8n pulls the record and its Google
Drive PDFs; **code parses the bank statements and computes every metric**; a small local LLM makes only the
judgement calls and writes the narrative; **a deterministic rules engine applies TerePay's thresholds and the
Borrower Behaviour Scorecard**; the result is stored and the website notified.

The LLM never counts and never decides. That is what makes the decision fast on a Pi and explainable for
CCCFA s.9CA records.

```
credit-assessment-agent/
├── prompts/credit-assessment-judgement.md    # v2 system prompt: judgement calls + narrative only (~1k tokens)
├── prompts/credit-assessment-framework.md    # v1 prompt: LLM counts from raw text — FALLBACK only
├── n8n/statement-analysis.js                 # parser + metrics + LLM brief + merge (pure JS)
├── n8n/scoring.js                            # rules engine: red-flag tiers, scoring matrix, behaviour scorecard
├── n8n/build-workflow.py                     # generates the two importable workflows below
├── n8n/credit-assessment-processor.json      # main workflow (19 nodes)
├── n8n/credit-assessment-error-handler.json  # error workflow
├── console/worker.js + assess.js             # Pi worker: training jobs + website AI assessments over Upstash Redis
├── sql/schema.sql                            # credit_assessments (+ audit columns) and assessment_errors
├── deploy/                                   # systemd units; n8n reads .env via EnvironmentFile
├── test/                                     # parser tests + end-to-end runner, no n8n needed
└── docs/                                     # the three source rule documents
```

## Pipeline

| Step | Node | What happens | Cost |
|---|---|---|---|
| 1 | Kafka Trigger → Normalise | `{application_id, user_id, timestamp}` | ms |
| 2 | Fetch Application Data → Check | `loan_applications` row (fails loudly if missing) | ms |
| 3 | Drive: folder named `<application_id>` → list PDFs → download → Extract PDF Text | text per PDF | seconds |
| 4 | **Analyse Statements** | every PDF is classified by content: statement (≥ 10 transactions), **payslip** (`parsePayslip` → net/gross per period, employer, pay date; `summarisePayslips` reconciles against statement credits and declared income) or other document; then `parseTransactions` (date / description / amount / running balance, sign from balance deltas) → `analyseTransactions` (income by pay cadence, BNPL, low-balance days, fees, credit facilities, gambling, alcohol, remittances, family transfers, bills regularity, lifestyle %) → `buildLlmBrief` | ms |
| 4b | (inside Analyse) | provisional `scoreAssessment` on the metrics alone → **RULES ENGINE FINDINGS** go into the model's brief, so the note can't contradict the decision | ms |
| 5 | Prepare LLM Prompt → **Call LLM** | ~1.5–2.2k-token brief + ~850-token prompt → one-line JSON: judgement booleans, behaviour ticks, 40–80-word analyst note, confidence, data gaps (≤ 350 tokens out) | the only slow step |
| 6 | **Parse & Score** | `repairJson` (tolerates truncation) → `mergeObservations` (metrics authoritative; every model boolean that can trigger a rule is **gated** on deterministic corroboration; behaviour ticks must be backed by words in the history document, or come from DB `behaviour_*` columns) → factors from rule hits, evidence = verbatim flagged statement lines → `scoreAssessment` | ms |
| 7 | Store Assessment → Notify Website | full audit row incl. `analysis_json`, `rule_hits_json`, `llm_raw_json`, `parser_mode` | ms |

Fallback: if no document yields ≥ 10 parsed transactions, the v1 prompt runs (model reads raw text) and the
rules engine **blocks automatic approval** (`parser_mode = fallback`, confidence ≤ 40). No documents at all →
Conditional / credit officer, never Approve.

## How the rules are applied

| Source document | Where |
|---|---|
| Expense Red Flags Checklist (9 categories, tiers) | metrics in `statement-analysis.js`; tiers in `scoring.js` |
| Client Behaviour Assessment Prompts (numeric thresholds, immediate-decline triggers, scoring matrix) | `scoring.js` immediate / critical / high / moderate lists |
| Borrower Behaviour Scorecard (+3…−5, 5 tiers, pathways) | model ticks items only from credit-history text; `scoring.js` WEIGHTS, tier, pathway |

Decision = worst of expense tier and behaviour tier:

| Condition | risk_rating | recommendation | escalation |
|---|---|---|---|
| Critical tier, any immediate-decline trigger, or behaviour ≤ −4 | High | Deny | decline (document per s.9CA) |
| High tier, or behaviour −1…−3 | High | Conditional | senior_credit_officer |
| Moderate tier, or behaviour 0…+1 | Medium | Conditional | credit_officer |
| Lower tier and behaviour ≥ +2 (or no history) | Low | Approve | none |

Interpretive choices you may want to revisit (all in one place, `scoring.js` / `statement-analysis.js`):
- 1 high indicator **or** 3+ moderate flags → Moderate (Implementation Note #3, cumulative effect).
- "$200 buffer maintained" = balance ≥ $200 on at least 50 % of days.
- "Zero balance events" = runs of consecutive ≤ $0 days, not individual days.
- Affordability guard: declared surplus ≤ 0, or observed income > 20 % off declared, blocks automatic Approve.
- Payslips: net pay > 20 % off the statement credits → `mismatch` (hold, verify which account is paid); declared income > 20 % above payslip → `declared_overstated` (hold); otherwise `verified` (positive factor). The model only ever sees the one-line PAYSLIPS summary, never the payslip text.
- "BNPL for basics", "credit paying credit", "crisis-driven remittances" etc. are judgement calls left to the
  model, but a model `true` is only accepted with corroboration (e.g. `credit_paying_credit` needs a loan advance
  credit in the statement; the remittance-while-BNPL-for-basics critical needs BNPL ≥ $200/mo **and** cash-stress
  evidence **and** remittances ≥ 10 % of income). Uncorroborated → `null`, which never triggers a rule.
- Borrower Behaviour Scorecard ticks: best source is TerePay's own loan history — add `behaviour_*` boolean columns
  to the application query and they are used as-is. Otherwise the model may tick items from credit-history text,
  and each tick must be backed by matching words in that text (a fabricated "existing defaults" is dropped).
- The model cannot subtract: it can add corroborated flags and context; it cannot remove a triggered finding.
- **Medical / unplanned-expense purpose never auto-approves** (TerePay portfolio observation that these loans default
  more often): it is at least Moderate → credit-officer review; with reduced recent income, ACC credits or medical
  spend > 10 % of income it becomes High → senior review. Framed as income-continuity/affordability checks under
  the CCCFA, never as a purpose-based decline.

## Setup

1. **Database** — run `sql/schema.sql` (needs `loan_applications(id UUID)`).
2. **Env** — `cp .env.example .env`, fill in, `chmod 600 .env`. n8n does **not** read `.env` itself; the
   systemd unit injects it (`deploy/n8n.service`). `$env.*` in the workflow depends on this.
3. **Services** — stop the manually started n8n, then `deploy/install-services.sh`.
4. **n8n credentials (UI)** — Postgres, Google Drive OAuth2, Kafka (SASL/SSL), SMTP.
5. **Import** both JSON files. Open each Postgres/Drive/Kafka/SMTP node once and pick the credential.
   Main workflow → Settings → Error workflow → "Credit Assessment - Error Handler".
6. **Drive layout** — `GOOGLE_DRIVE_ROOT_FOLDER_ID` contains one sub-folder per application named exactly the
   `application_id`, holding the PDFs (statements and any credit-history documents).
7. Activate.

After editing a prompt, `scoring.js` or `statement-analysis.js`: `python3 n8n/build-workflow.py` → re-import.

## Test without n8n

```bash
cd test
node parse_test.js sample-statement-flagged.txt          # parser + metrics + rules, no LLM (instant)
node parse_test.js sample-statement-flagged.txt sample-application.json brief   # what the model will see
./run-local-test.sh flagged                              # full v2 pipeline against the local LLM
./run-local-test.sh clean
LLM_BACKEND=openai LLM_API_URL=http://localhost:8080 ./run-local-test.sh flagged   # llama.cpp llama-server
./run-local-test.sh flagged llama3.2:3b --v1             # old "LLM counts everything" mode, for comparison
```
Outputs in `test/out/`. **Always run new bank formats through `parse_test.js` first** — if it reports few
transactions or "Balance delta mismatch" notes, extend the date/amount patterns in `statement-analysis.js`.

## Performance on the Pi 5 (measured, llama3.2:3b unless stated; both samples decided correctly in every v2 run)

| Version | What the model does | Prompt → output tokens | Wall time (flagged / clean) | Notes |
|---|---|---|---|---|
| v1 | counts everything from raw statement text (16k ctx) | 4,330 → 1,120 | **918 s** / – | verdict right by luck: missed gambling and remittances, invented a BNPL count |
| v2.0 | code counts; model judges + writes narrative | 1,819 → 648 | – / 237 s | correct; verbose output |
| v2.1 | + findings given up front, gated judgements | 2,036 → 318 | 203 s / 184 s | correct; still writing factors/evidence the engine already has |
| **v2.2** | judgements + 40–80-word analyst note only; trimmed brief | 1,832 → 115 / 1,343 → 112 | **90 s / 55 s** | correct; coherent 60–70-word notes |
| v2.2, qwen2.5:1.5b-instruct | same | ~2,250 → 240–350 | 86 s / 51 s | correct decisions, but notes hallucinate ("$4,000 significantly lower than $4,008") and loop — not fit for the file |
| rules engine alone | – | – | < 50 ms | identical decisions on both samples |

Hardware ceiling: llama3.2:3b Q4 generates ~5.3 tok/s with an empty context on this Pi (Ollama and a natively
compiled llama.cpp give the same number — `test/out-bench.log`), falling to ~3.5–4 tok/s with a 2k-token prompt.
Prompt ingestion runs 20–50 tok/s, so with the output now small, **prompt length is the main cost** — hence the
trimmed brief. Ollama re-uses the KV cache for an unchanged prompt prefix, so the ~850-token system prompt costs
little once the model is warm and serving one workflow. Expect **60–120 s per assessment** in steady state.

Recommended: `OLLAMA_MODEL=llama3.2:3b`. The decision never depends on the model, so a faster model only trades
note quality for speed; qwen2.5:1.5b is not worth it. Further options if 60–120 s is still too slow:
1. Hailo-10H `hailo-ollama` for the note (zero CPU) — the model's job is now small enough for a 1–1.5B NPU model.
2. Skip the model entirely for clear-cut cases (Critical with ≥ 2 immediate-decline triggers, or Lower with zero
   flags and DB behaviour ≥ +5): the stored reasoning header already documents the decision; a credit officer adds
   the note. That makes most assessments sub-second.
3. `llama3.2:3b` with `num_thread` left default; do not run two assessments concurrently (`OLLAMA_NUM_PARALLEL=1`).

## Trainer console (`console/`, port 8787, `systemctl --user restart terepay-console`)

`Cases` — upload one application (several statements + payslips + history note) or a **ZIP batch of historical
applications with an `applications.csv` of declared figures and outcomes**; format in
[docs/historical-data-format.md](docs/historical-data-format.md). Each case is parsed and scored instantly (no LLM).
`Backtest` — bad rate by engine tier / recommendation / TerePay decision / trigger, and the misses in both
directions; this is the evidence for changing thresholds in `scoring.js`. Then gold review → dataset → fine-tune → exam
as before. Cases live in `training/real/<id>/` (`documents.json`, `<kind>-N.txt`, `application.json`, `analysis.json`, `label.json`).

## Training from the TerePay website (`console/worker.js`)

The admin-only **Model Training** page on the TerePay site replaces the LAN console for day-to-day use. It queues
jobs in **Upstash Redis** (`training:queue`); `console/worker.js` on the Pi polls the queue over HTTPS (no inbound
port), pulls training data from the shared **Google Drive training folder**, runs the exact same functions as the
console, and writes status, log tail and result back to `training:job:<id>` for the page to display.

Job types: `import_batch` (Drive folder or `.zip` of historical applications), `import_outcomes` (`.csv`),
`backtest`, `build_dataset`, `finetune`, `exam`, `regenerate_synthetic`.

Setup: add the `UPSTASH_*` and `GOOGLE_DRIVE_*` values to `.env` (see `.env.example`), then
```bash
cd console && npm install
cp ../deploy/terepay-worker.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user enable --now terepay-worker && journalctl --user -u terepay-worker -f
```
The LAN console keeps working unchanged (`server.js` exports its functions; `require.main` guards `listen`).
`console/rpc.js` answers the website's quick requests (case list/detail, labels, gold reviews, backtest, exams,
settings) over `training:rpc` → `training:rpc:<id>`; the worker pumps that list every second, even during a long job.

## AI assessment from the TerePay website (`console/assess.js`, same worker)

The lender's **affordability wizard → Results & Decision** step has a *Run AI assessment* button. The site assembles
**every input** the pipeline needs — applicant, amount under assessment, rate, verified monthly income / expenses from the
wizard, existing debt, purpose, `behaviour_*` ticks derived from TerePay's own repayment history, and the Drive ids of
the statements / payslips in the application's `app_<id>` folder — and refuses to queue the job if anything is missing
(`MISSING_INPUTS`). The worker validates the payload again, downloads the documents (only from inside
`GOOGLE_DRIVE_KYC_FOLDER_ID`), and runs the exact n8n pipeline: parse → metrics → provisional rules → LLM judgement +
analyst note → gated merge → rules engine. Result goes back on the job hash; the site stores it in Firestore
(`creditAssessments/<jobId>`) and on the affordability assessment the lender submits. Advisory only — the lender decides.

```
site --LPUSH--> assessment:queue --RPOP--> worker.js --HSET--> assessment:job:<id> <--HGETALL-- site (polls every 4 s)
```
Assessment jobs are drained **before** training jobs. Audit copies land in `training/assessments/<applicationId>/<jobId>/`
(payload, document text, `analysis.json`, `llm-raw.json`, `result.json`) — they are not training cases.
If the model loops on a list and hits the token cap before writing the note (seen with llama3.2:3b on some briefs), the
job asks once more for the note alone (`repeat_penalty` 1.3, ≤ 160 tokens, `llm-raw-note.json`); the decision is never
affected because the rules engine scores the metrics either way.

```bash
node test/assess_local_test.js flagged            # full pipeline incl. the model, no Redis / Drive needed
node test/assess_local_test.js clean --missing    # proves an incomplete payload is refused
```
Site side: `docs/AI_CREDIT_ASSESSMENT.md` in the terepay-platform repo.

## Ops

```bash
journalctl -u n8n -f
systemctl --user status ollama          # (or: journalctl -u ollama -f if installed system-wide)
curl -s localhost:11434/api/ps          # model loaded, context size
```
SQL: `SELECT application_id, risk_rating, recommendation, confidence_score, expense_risk_tier, behaviour_score, escalation, parser_mode, processing_ms, created_at FROM credit_assessments ORDER BY created_at DESC LIMIT 20;`

## Spec deviations (and why)

- Model: spec says `mistral`; only `llama3.2:3b` is installed. Configurable (`OLLAMA_MODEL`). With v2 the model
  only writes narrative, so a small model is adequate — test any change with `run-local-test.sh`.
- The AI HAT does not accelerate Ollama; it runs on CPU.
- Ollama call: `/api/chat`, system message, `format: "json"`, `temperature` under `options` (top-level is
  ignored), explicit `num_ctx`.
- PDF text via n8n's Extract From File node; scanned PDFs are reported as `unreadable` (add OCR if frequent).
- Error handling via n8n's Error Workflow (no "Catch Error" node exists).
- Upstash Kafka was sunset in 2025 — swap the trigger for a Webhook node if you moved to QStash/HTTP.
- Spec's test message used `"application_id": "test-app-123"`, which fails against a UUID column.
