# Phase 2 — fine-tuning the analyst model (off-Pi)

The decision is made by code; the model only writes judgements + a 40–80-word analyst note. Fine-tuning makes that
part faster (shorter prompt, fewer output tokens, fewer repairs) and more consistent. It never changes a decision.

## Data
`training/out/train.jsonl` — 175 examples (system prompt + production brief → gold JSON), built from the synthetic
migrant-lending cases by `training/build_gold.js`. `training/out/exam.json` — 25 held-out cases with gold answers.
Regenerate with a different seed / size:
```bash
node training/generate.js --n 600 --seed 23 --out training/data
node training/eval_parser.js training/data          # parser must stay ~100 % before labels are trusted
node training/build_gold.js training/data training/out
```
Have a credit officer read ~20 random `analyst_note`s in `training/out/gold-all.json` before training on them.

## Train (GPU machine, ~30–60 min)
```bash
cd training/finetune
pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git" trl datasets
python train_lora.py --base unsloth/Llama-3.2-3B-Instruct  --data ../out/train.jsonl --out terepay-analyst-3b
python train_lora.py --base unsloth/Qwen2.5-1.5B-Instruct --data ../out/train.jsonl --out terepay-analyst-1.5b
```
Copy `<out>/*.gguf` + `<out>/Modelfile` to the Pi, then:
```bash
ollama create terepay-analyst -f Modelfile
```

## Exam (on the Pi) — before and after
```bash
node training/run_exam.js --model llama3.2:3b --n 25          # baseline
node training/run_exam.js --model terepay-analyst --n 25      # fine-tuned
```
Scores: JSON validity, judgement precision/recall vs gold, behaviour-tick F1, note length, coverage of the
triggered findings, contradictions, invented numbers, conclusion consistent with the decision, seconds per case.
Adopt the fine-tuned model only if it is at least as good on every quality metric and faster.
Then set `OLLAMA_MODEL=terepay-analyst` in `.env` and restart n8n.

## Phase 3 — when real (redacted) data exists
1. Run `node test/parse_test.js <statement.txt>` on each new bank format; extend patterns until transaction counts match.
2. Backtest: run the rules engine over past applications with known outcomes; compare tiers to actual defaults,
   especially the medical-purpose cohort. Adjust thresholds in `scoring.js` — that is the calibration that matters.
3. Rebuild gold from real briefs (labels reviewed by a credit officer) and fine-tune again.
