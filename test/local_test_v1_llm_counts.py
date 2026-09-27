#!/usr/bin/env python3
"""Runs the framework prompt against local Ollama exactly as the n8n workflow does,
then applies scoring.js. Usage: python3 local_test.py [flagged|clean] [model]"""
import json, os, sys, time, subprocess, pathlib, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent.parent
which = sys.argv[1] if len(sys.argv) > 1 else "flagged"
model = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
base = os.environ.get("OLLAMA_API_URL", "http://localhost:11434")
num_ctx = int(os.environ.get("OLLAMA_NUM_CTX", "8192"))

framework = (ROOT / "prompts/credit-assessment-framework.md").read_text()
app = json.loads((ROOT / "test/sample-application.json").read_text())
doc = (ROOT / f"test/sample-statement-{which}.txt").read_text()
money = lambda v: "not provided" if v is None else f"${v:,}"
user = f"""APPLICATION DATA
- Application ID: {app['id']}
- Applicant: {app['applicant_name']}
- Requested amount: {money(app['loan_amount'])}
- Interest rate: {app['interest_rate']}% p.a.
- Declared monthly income: {money(app['income'])}
- Declared monthly expenses: {money(app['expenses'])}
- Existing debt: {money(app['existing_debt'])}
- Declared monthly surplus: {money(app['income'] - app['expenses'])}
- Submitted: {app['created_at']}

SUPPORTING DOCUMENTS (extracted text)

===== DOCUMENT: bank-statement.pdf (2 pages) =====
{doc}

Screen the documents against the framework. Count, don't estimate. Quote transaction lines with dates as evidence. Return ONLY the JSON object described in Part C."""

body = {"model": model, "messages": [{"role": "system", "content": framework}, {"role": "user", "content": user}],
        "stream": False, "format": "json", "keep_alive": "30m",
        "options": {"temperature": 0.1, "num_ctx": num_ctx, "num_predict": 1500, "seed": 7}}
print(f"model={model} sample={which} prompt_chars={len(framework)+len(user)} num_ctx={num_ctx}", flush=True)
t0 = time.time()
req = urllib.request.Request(f"{base}/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
resp = json.loads(urllib.request.urlopen(req, timeout=3000).read())
dt = time.time() - t0
print(f"done in {dt:.0f}s  prompt_tokens={resp.get('prompt_eval_count')} output_tokens={resp.get('eval_count')} "
      f"eval_rate={resp.get('eval_count',0)/max(resp.get('eval_duration',1)/1e9,1e-9):.1f} tok/s", flush=True)
out = ROOT / "test/out"; out.mkdir(exist_ok=True)
raw = resp["message"]["content"]
(out / f"{which}-{model.replace(':','_')}-llm.json").write_text(raw)
try:
    llm = json.loads(raw)
except Exception as e:
    print("LLM output was not valid JSON:", e); print(raw[:1500]); sys.exit(1)
(out / f"{which}-app.json").write_text(json.dumps(app))
res = subprocess.run(["node", str(ROOT / "test/score.js"), str(out / f"{which}-{model.replace(':','_')}-llm.json"), str(out / f"{which}-app.json"), "1"],
                     capture_output=True, text=True)
print(res.stdout); print(res.stderr, file=sys.stderr)
(out / f"{which}-{model.replace(':','_')}-scored.json").write_text(res.stdout)
