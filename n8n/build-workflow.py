#!/usr/bin/env python3
"""Builds the importable n8n workflow JSON files from prompts/, scoring.js and statement-analysis.js.
Re-run after editing any of those, then re-import in n8n.

Flow (v2): queue -> application row -> Drive PDFs -> text -> DETERMINISTIC PARSE + METRICS (code)
        -> small judgement prompt to the LLM -> merge metrics + judgements -> RULES ENGINE (code) -> store -> notify.
Fallback: if no statement parses (>= 10 transactions), the v1 "LLM counts from raw text" prompt is used and the
rules engine blocks automatic approval (parser_mode = fallback)."""
import json, pathlib, uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRAMEWORK_V1 = (ROOT / "prompts/credit-assessment-framework.md").read_text()
JUDGEMENT_V2 = (ROOT / "prompts/credit-assessment-judgement.md").read_text()
SCORING = (ROOT / "n8n/scoring.js").read_text().replace("if (typeof module !== 'undefined') module.exports = { scoreAssessment };", "")
ANALYSIS = (ROOT / "n8n/statement-analysis.js").read_text().replace("if (typeof module !== 'undefined') module.exports = { parseTransactions, analyseTransactions, buildLlmBrief, mergeObservations, repairJson, cleanNote, classify, PATTERNS: P, BEHAVIOUR_KEYS, looksLikePayslip, parsePayslip, summarisePayslips };", "")
FRAMEWORK_VERSION = "2.2"

def nid(): return str(uuid.uuid4())

def node(name, type_, ver, params, pos, **extra):
    d = {"parameters": params, "id": nid(), "name": name, "type": type_, "typeVersion": ver, "position": pos}
    d.update(extra); return d

def code(js): return {"jsCode": js}

# ---------------- Code node sources ----------------
NORMALISE = r"""
const m = $input.first().json;
let body = (m && typeof m.message === 'object' && m.message) ? m.message : m;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { throw new Error('Queue message is not JSON: ' + body.slice(0, 200)); } }
const application_id = body.application_id;
if (!application_id) throw new Error('Queue message missing application_id: ' + JSON.stringify(body).slice(0, 300));
return [{ json: { application_id: String(application_id), user_id: String(body.user_id || body.email || 'unknown'), timestamp: body.timestamp || new Date().toISOString(), raw: body } }];
"""

CHECK_APP = r"""
const row = $input.first().json || {};
if (!row.id) throw new Error('No loan_applications row found for id ' + $('Normalise Trigger').first().json.application_id);
return [{ json: row }];
"""

COLLECT_DOCS = r"""
let dl = []; try { dl = $('Download PDF').all(); } catch (e) {}
const NUL = String.fromCharCode(0);
const docs = $input.all().map((it, i) => {
  const bin = (it.binary && it.binary.data) || (dl[i] && dl[i].binary && dl[i].binary.data) || {};
  const meta = (dl[i] && dl[i].json) || {};
  return { fileName: bin.fileName || meta.name || `document-${i + 1}.pdf`, fileId: meta.id || null, pages: it.json.numpages || null, text: String(it.json.text || '').split(NUL).join('').trim() };
});
return [{ json: { documents: docs.filter(d => d.text.length > 0), unreadable: docs.filter(d => !d.text.length).map(d => d.fileName) } }];
"""

ANALYSE = SCORING + ANALYSIS + r"""
// ---- n8n glue: parse every document, pool statement transactions, keep the rest as "other documents" ----
const inp = $input.first().json || {};
const documents = Array.isArray(inp.documents) ? inp.documents : [];
const app = $('Check Application').first().json;
const statements = [], others = [], payslips = [], seen = new Set(); let allTx = [];
for (const d of documents) {
  const p = parseTransactions(d.text);
  if (p.transactions.length >= 10) {
    statements.push({ fileName: d.fileName, fileId: d.fileId, transactions: p.transactions.length, opening_balance: p.opening_balance, notes: p.notes });
    for (const t of p.transactions) { const k = t.date + '|' + t.line; if (!seen.has(k)) { seen.add(k); allTx.push(t); } }
    if (p.residual_text && p.residual_text.length > 120) others.push({ fileName: d.fileName + ' (notes)', text: p.residual_text });   // prose inside a statement PDF (e.g. history notes)
  } else if (looksLikePayslip(d.text)) {
    payslips.push(Object.assign({ fileName: d.fileName, fileId: d.fileId }, parsePayslip(d.text)));
  } else {
    others.push(d);
  }
}
allTx.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const mode = allTx.length >= 10 ? 'deterministic' : (documents.length ? 'fallback' : 'none');
const analysis = mode === 'deterministic' ? analyseTransactions(allTx) : { parser: { transaction_count: allTx.length, mode } };
analysis.parser.mode = mode; analysis.parser.statements = statements; analysis.parser.payslips = payslips.map(p => ({ fileName: p.fileName, net: p.net, gross: p.gross, pay_date: p.pay_date, frequency: p.frequency }));
if (payslips.length) analysis.payslips = summarisePayslips(payslips, mode === 'deterministic' ? analysis : null, app);
const otherText = others.map(d => `--- ${d.fileName} ---\n${d.text}`).join('\n\n').slice(0, Number($env.MAX_OTHER_DOC_CHARS || 6000));
const hasOtherDocs = otherText.length > 0;
const findings = mode === 'deterministic' ? scoreAssessment(mergeObservations(analysis, {}, { hasOtherDocs, otherDocsText: otherText, dbBehaviour: app }), app, { documentCount: documents.length, parserMode: mode }) : null;
const brief = mode === 'deterministic' ? buildLlmBrief(analysis, app, otherText, findings) : null;
const rawText = documents.map(d => `\n\n===== DOCUMENT: ${d.fileName} =====\n${d.text}`).join('').slice(0, Number($env.MAX_DOC_CHARS || 20000));
return [{ json: { mode, analysis, brief, has_other_docs: hasOtherDocs, provisional: findings ? { risk_rating: findings.risk_rating, recommendation: findings.recommendation, expense_risk_tier: findings.expense_risk_tier, rule_hits: findings.rule_hits } : null, other_docs_text: otherText, raw_text: rawText, statements,
  documents_used: documents.map(d => ({ fileName: d.fileName, fileId: d.fileId, chars: d.text.length })), unreadable: inp.unreadable || [], document_count: documents.length } }];
"""

PREPARE = "const FRAMEWORK_V1 = " + json.dumps(FRAMEWORK_V1) + ";\nconst JUDGEMENT_V2 = " + json.dumps(JUDGEMENT_V2) + ";\nconst FRAMEWORK_VERSION = " + json.dumps(FRAMEWORK_VERSION) + ";\n" + r"""
const trig = $('Normalise Trigger').first().json;
const app = $('Check Application').first().json;
const an = $input.first().json;
const money = v => (v === null || v === undefined || v === '') ? 'not provided' : `$${Number(v).toLocaleString('en-NZ')}`;
let system, user, num_ctx, num_predict;
if (an.mode === 'deterministic') {
  system = JUDGEMENT_V2;
  user = 'VERIFIED METRICS AND STATEMENT LINES\n' + an.brief + (an.unreadable.length ? `\n\n(Unreadable / image-only documents: ${an.unreadable.join(', ')})` : '') + '\n\nMake the judgement calls and write the narrative. Return ONLY the JSON object.';
  num_ctx = Number($env.OLLAMA_NUM_CTX || 6144); num_predict = 350;
} else {
  system = FRAMEWORK_V1;
  const surplus = (app.income != null && app.expenses != null) ? money(Number(app.income) - Number(app.expenses)) : 'not provided';
  const docText = an.document_count ? an.raw_text : '\n\n(No supporting documents were found for this application. Set counts to null and list this in data_gaps.)';
  user = `APPLICATION DATA
- Application ID: ${app.id}
- Applicant: ${app.applicant_name || 'not provided'}
- Requested amount: ${money(app.loan_amount)}
- Interest rate: ${app.interest_rate != null ? app.interest_rate + '% p.a.' : 'not provided'}
- Declared monthly income: ${money(app.income)}
- Declared monthly expenses: ${money(app.expenses)}
- Existing debt: ${money(app.existing_debt)}
- Declared monthly surplus: ${surplus}

SUPPORTING DOCUMENTS (extracted text)${docText}${an.unreadable.length ? `\n\n(Unreadable / image-only documents: ${an.unreadable.join(', ')})` : ''}

Screen the documents against the framework. Count, don't estimate. Quote transaction lines with dates as evidence. Return ONLY the JSON object described in Part C.`;
  num_ctx = Number($env.OLLAMA_FALLBACK_NUM_CTX || 8192); num_predict = 1500;
}
const backend = ($env.LLM_BACKEND || 'ollama').toLowerCase();          // 'ollama' | 'openai' (llama.cpp llama-server, vLLM, etc.)
const model = $env.OLLAMA_MODEL || 'llama3.2:3b';
const messages = [ { role: 'system', content: system }, { role: 'user', content: user } ];
let llm_url, llm_body;
if (backend === 'openai') {
  llm_url = ($env.LLM_API_URL || 'http://localhost:8080') + '/v1/chat/completions';
  llm_body = { model, messages, temperature: 0.1, max_tokens: num_predict, seed: 7, response_format: { type: 'json_object' }, stream: false };
} else {
  llm_url = ($env.OLLAMA_API_URL || 'http://localhost:11434') + '/api/chat';
  llm_body = { model, messages, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.1, num_ctx, num_predict, seed: 7 } };
}
return [{ json: { system, user, mode: an.mode, backend, model, num_ctx, num_predict, llm_url, llm_body, framework_version: FRAMEWORK_VERSION, documents_used: an.documents_used, unreadable: an.unreadable, document_count: an.document_count, started_at: Date.now(), application: app, trigger: trig } }];
"""

PARSE = SCORING + ANALYSIS + r"""
const resp = $input.first().json;
const prep = $('Prepare LLM Prompt').first().json;
const an = $('Analyse Statements').first().json;
let raw = (resp.message && resp.message.content) || (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || resp.response || '';
const parsed = repairJson(raw);
const llm = parsed.value;
const observations = an.mode === 'deterministic' ? mergeObservations(an.analysis, llm, { hasOtherDocs: an.has_other_docs, otherDocsText: an.other_docs_text, dbBehaviour: prep.application }) : llm;
const result = scoreAssessment(observations, prep.application, { documentCount: an.document_count, parserMode: an.mode });
return [{ json: Object.assign(result, {
  application_id: prep.application.id,
  triggered_by: prep.trigger.user_id,
  model: prep.model,
  framework_version: prep.framework_version,
  parser_mode: an.mode,
  analysis: an.analysis,
  documents_used: prep.documents_used,
  llm_raw: llm,
  llm_json_repaired: parsed.repaired,
  rejected_behaviour_ticks: observations.rejected_behaviour_ticks || [],
  provisional: an.provisional,
  backend: prep.backend,
  llm_stats: { prompt_tokens: resp.prompt_eval_count || (resp.usage && resp.usage.prompt_tokens) || null, output_tokens: resp.eval_count || (resp.usage && resp.usage.completion_tokens) || null, model_ms: resp.total_duration ? Math.round(resp.total_duration / 1e6) : (resp.timings ? Math.round((resp.timings.prompt_ms || 0) + (resp.timings.predicted_ms || 0)) : null) },
  processing_ms: Date.now() - prep.started_at,
  n8n_execution_id: String($execution.id || '')
}) }];
"""

DB_ROW = r"""
const a = $input.first().json;
return [{ json: {
  application_id: a.application_id, triggered_by: a.triggered_by,
  risk_rating: a.risk_rating, recommendation: a.recommendation, confidence_score: a.confidence_score,
  factors_json: JSON.stringify(a.factors), reasoning: a.reasoning, evidence_json: JSON.stringify(a.evidence),
  expense_risk_tier: a.expense_risk_tier, behaviour_score: a.behaviour_score, behaviour_tier: a.behaviour_tier, escalation: a.escalation,
  rule_hits_json: JSON.stringify(a.rule_hits), llm_raw_json: JSON.stringify(a.llm_raw), llm_preliminary_view: a.llm_preliminary_view,
  model: a.model, framework_version: a.framework_version, documents_json: JSON.stringify(a.documents_used),
  analysis_json: JSON.stringify(a.analysis), parser_mode: a.parser_mode,
  processing_ms: a.processing_ms, n8n_execution_id: a.n8n_execution_id
} }];
"""

ERROR_RECORD = r"""
const e = $input.first().json || {};
const ex = e.execution || {};
const err = ex.error || (e.trigger && e.trigger.error) || {};
return [{ json: {
  application_id: null,
  n8n_execution_id: ex.id ? String(ex.id) : null,
  workflow_name: (e.workflow || {}).name || null,
  error_step: ex.lastNodeExecuted || (err.node && err.node.name) || 'trigger',
  error_message: String(err.message || 'Unknown error').slice(0, 4000),
  error_stack: String(err.stack || '').slice(0, 20000),
  execution_url: ex.url || null
} }];
"""

def if_not_empty(expr):
    return {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": nid(), "leftValue": expr, "rightValue": "", "operator": {"type": "string", "operation": "notEmpty", "singleValue": True}}],
            "combinator": "and"}, "options": {}}

def pg_insert(table):
    return {"operation": "insert",
            "schema": {"__rl": True, "mode": "list", "value": "public"},
            "table": {"__rl": True, "mode": "list", "value": table},
            "columns": {"mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [], "schema": []},
            "options": {}}

# ---------------- Main workflow ----------------
nodes = [
 node("Kafka Trigger", "n8n-nodes-base.kafkaTrigger", 1,
      {"topic": "loan-assessment-request", "groupId": "credit-assessor-group",
       "options": {"jsonParseMessage": True, "onlyMessage": True, "parallelProcessing": False}}, [0, 300],
      notes="Upstash Kafka was sunset in 2025. If you use QStash or a plain HTTP producer, replace this node with a Webhook node (POST, JSON body {application_id,user_id,timestamp}) - nothing downstream changes."),
 node("Normalise Trigger", "n8n-nodes-base.code", 2, code(NORMALISE), [220, 300]),
 node("Fetch Application Data", "n8n-nodes-base.postgres", 2.4,
      {"operation": "executeQuery",
       "query": "-- Optional: add behaviour_* boolean columns (behaviour_paid_previous_loan_early, behaviour_missed_payments_before, ...) from TerePay's loan history; they are used as the authoritative Borrower Behaviour Scorecard ticks.\nSELECT id, applicant_name, loan_amount, interest_rate, income, expenses, existing_debt, loan_purpose, created_at\nFROM loan_applications\nWHERE id = $1",
       "options": {"queryReplacement": "={{ $json.application_id }}"}}, [440, 300], alwaysOutputData=True),
 node("Check Application", "n8n-nodes-base.code", 2, code(CHECK_APP), [660, 300]),
 node("Find Application Folder", "n8n-nodes-base.googleDrive", 3,
      {"resource": "fileFolder", "searchMethod": "query",
       "queryString": "=name = '{{ $json.id }}' and mimeType = 'application/vnd.google-apps.folder' and '{{ $env.GOOGLE_DRIVE_ROOT_FOLDER_ID }}' in parents and trashed = false",
       "returnAll": False, "limit": 1, "filter": {}, "options": {"fields": ["id", "name", "mimeType"]}}, [880, 300], alwaysOutputData=True),
 node("Folder Found?", "n8n-nodes-base.if", 2.2, if_not_empty("={{ $json.id }}"), [1100, 300]),
 node("List PDF Documents", "n8n-nodes-base.googleDrive", 3,
      {"resource": "fileFolder", "searchMethod": "query",
       "queryString": "='{{ $json.id }}' in parents and mimeType = 'application/pdf' and trashed = false",
       "returnAll": True, "filter": {}, "options": {"fields": ["id", "name", "mimeType", "size", "modifiedTime"]}}, [1320, 200], alwaysOutputData=True),
 node("Has Documents?", "n8n-nodes-base.if", 2.2, if_not_empty("={{ $json.id }}"), [1540, 200]),
 node("Download PDF", "n8n-nodes-base.googleDrive", 3,
      {"resource": "file", "operation": "download", "fileId": {"__rl": True, "mode": "id", "value": "={{ $json.id }}"},
       "options": {"binaryPropertyName": "data"}}, [1760, 100]),
 node("Extract PDF Text", "n8n-nodes-base.extractFromFile", 1,
      {"operation": "pdf", "binaryPropertyName": "data", "options": {"joinPages": True, "keepSource": "both"}}, [1980, 100],
      notes="Image-only (scanned) PDFs yield no text and are reported as 'unreadable'. Add an OCR step (ocrmypdf/tesseract) before this node if that happens often."),
 node("Collect Documents", "n8n-nodes-base.code", 2, code(COLLECT_DOCS), [2200, 100]),
 node("No Documents", "n8n-nodes-base.set", 3.4, {"mode": "raw", "jsonOutput": "{\n  \"documents\": [],\n  \"unreadable\": []\n}", "options": {}}, [1760, 480]),
 node("Analyse Statements", "n8n-nodes-base.code", 2, code(ANALYSE), [2420, 300],
      notes="Deterministic transaction parser + metrics (statement-analysis.js). The LLM never counts; every number here is reproducible and stored in analysis_json."),
 node("Prepare LLM Prompt", "n8n-nodes-base.code", 2, code(PREPARE), [2640, 300]),
 node("Call LLM", "n8n-nodes-base.httpRequest", 4.2,
      {"method": "POST", "url": "={{ $json.llm_url }}",
       "sendBody": True, "specifyBody": "json",
       "jsonBody": "={{ JSON.stringify($json.llm_body) }}",
       "options": {"timeout": 900000}}, [2860, 300], retryOnFail=True, maxTries=2, waitBetweenTries=10000,
      notes="LLM_BACKEND=ollama -> /api/chat with format:json; LLM_BACKEND=openai -> /v1/chat/completions with response_format json_object (llama.cpp llama-server). Request is built in Prepare LLM Prompt."),
 node("Parse & Score", "n8n-nodes-base.code", 2, code(PARSE), [3080, 300],
      notes="Merges deterministic metrics with the model's judgement calls, then applies TerePay's scoring matrix (scoring.js)."),
 node("Build DB Row", "n8n-nodes-base.code", 2, code(DB_ROW), [3300, 300]),
 node("Store Assessment", "n8n-nodes-base.postgres", 2.4, pg_insert("credit_assessments"), [3520, 300]),
 node("Notify Website", "n8n-nodes-base.httpRequest", 4.2,
      {"method": "POST", "url": "={{ $env.WEBSITE_WEBHOOK_URL }}",
       "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Authorization", "value": "=Bearer {{ $env.WEBSITE_WEBHOOK_TOKEN }}"}]},
       "sendBody": True, "specifyBody": "json",
       "jsonBody": "={{ JSON.stringify({ application_id: $('Parse & Score').first().json.application_id, assessment_id: $json.id, risk_rating: $json.risk_rating, recommendation: $json.recommendation, confidence_score: $json.confidence_score, escalation: $json.escalation, expense_risk_tier: $json.expense_risk_tier, behaviour_score: $json.behaviour_score, parser_mode: $json.parser_mode, completed_at: $json.created_at }) }}",
       "options": {"timeout": 30000}}, [3740, 300], retryOnFail=True, maxTries=3, waitBetweenTries=5000),
]
conn = {
 "Kafka Trigger":           {"main": [[{"node": "Normalise Trigger", "type": "main", "index": 0}]]},
 "Normalise Trigger":       {"main": [[{"node": "Fetch Application Data", "type": "main", "index": 0}]]},
 "Fetch Application Data":  {"main": [[{"node": "Check Application", "type": "main", "index": 0}]]},
 "Check Application":       {"main": [[{"node": "Find Application Folder", "type": "main", "index": 0}]]},
 "Find Application Folder": {"main": [[{"node": "Folder Found?", "type": "main", "index": 0}]]},
 "Folder Found?":           {"main": [[{"node": "List PDF Documents", "type": "main", "index": 0}], [{"node": "No Documents", "type": "main", "index": 0}]]},
 "List PDF Documents":      {"main": [[{"node": "Has Documents?", "type": "main", "index": 0}]]},
 "Has Documents?":          {"main": [[{"node": "Download PDF", "type": "main", "index": 0}], [{"node": "No Documents", "type": "main", "index": 0}]]},
 "Download PDF":            {"main": [[{"node": "Extract PDF Text", "type": "main", "index": 0}]]},
 "Extract PDF Text":        {"main": [[{"node": "Collect Documents", "type": "main", "index": 0}]]},
 "Collect Documents":       {"main": [[{"node": "Analyse Statements", "type": "main", "index": 0}]]},
 "No Documents":            {"main": [[{"node": "Analyse Statements", "type": "main", "index": 0}]]},
 "Analyse Statements":      {"main": [[{"node": "Prepare LLM Prompt", "type": "main", "index": 0}]]},
 "Prepare LLM Prompt":      {"main": [[{"node": "Call LLM", "type": "main", "index": 0}]]},
 "Call LLM":                {"main": [[{"node": "Parse & Score", "type": "main", "index": 0}]]},
 "Parse & Score":           {"main": [[{"node": "Build DB Row", "type": "main", "index": 0}]]},
 "Build DB Row":            {"main": [[{"node": "Store Assessment", "type": "main", "index": 0}]]},
 "Store Assessment":        {"main": [[{"node": "Notify Website", "type": "main", "index": 0}]]},
}
main_wf = {"name": "Credit Assessment Processor", "nodes": nodes, "connections": conn,
           "settings": {"executionOrder": "v1", "saveManualExecutions": True, "saveDataErrorExecution": "all", "saveDataSuccessExecution": "all", "executionTimeout": 1800, "timezone": "Pacific/Auckland"},
           "meta": {"framework_version": FRAMEWORK_VERSION}}

# ---------------- Error workflow ----------------
enodes = [
 node("Error Trigger", "n8n-nodes-base.errorTrigger", 1, {}, [0, 300]),
 node("Build Error Record", "n8n-nodes-base.code", 2, code(ERROR_RECORD), [220, 300]),
 node("Log Error", "n8n-nodes-base.postgres", 2.4, pg_insert("assessment_errors"), [440, 300], continueOnFail=True),
 node("Email Loan Manager", "n8n-nodes-base.emailSend", 2.1,
      {"fromEmail": "={{ $env.SMTP_USER }}", "toEmail": "={{ $env.ERROR_ALERT_EMAIL }}",
       "subject": "=[Credit Assessment] FAILED at {{ $json.error_step }} - execution {{ $json.n8n_execution_id }}",
       "emailFormat": "text",
       "text": "=Credit Assessment Processor failed.\n\nWorkflow: {{ $json.workflow_name }}\nStep: {{ $json.error_step }}\nExecution: {{ $json.n8n_execution_id }}\nWhen: {{ $now.setZone('Pacific/Auckland').toFormat('yyyy-LL-dd HH:mm:ss ZZZZ') }}\n\nError:\n{{ $json.error_message }}\n\nOpen the execution to see the application_id in the trigger data:\n{{ $json.execution_url }}\n\nStack:\n{{ $json.error_stack }}",
       "options": {}}, [660, 300]),
]
econn = {
 "Error Trigger":      {"main": [[{"node": "Build Error Record", "type": "main", "index": 0}]]},
 "Build Error Record": {"main": [[{"node": "Log Error", "type": "main", "index": 0}]]},
 "Log Error":          {"main": [[{"node": "Email Loan Manager", "type": "main", "index": 0}]]},
}
err_wf = {"name": "Credit Assessment - Error Handler", "nodes": enodes, "connections": econn,
          "settings": {"executionOrder": "v1", "timezone": "Pacific/Auckland"}}

out = ROOT / "n8n"
(out / "credit-assessment-processor.json").write_text(json.dumps(main_wf, indent=2))
(out / "credit-assessment-error-handler.json").write_text(json.dumps(err_wf, indent=2))
print("wrote", out / "credit-assessment-processor.json", len(nodes), "nodes")
print("wrote", out / "credit-assessment-error-handler.json", len(enodes), "nodes")
