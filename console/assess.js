#!/usr/bin/env node
// TerePay AI credit assessment — one job from the website's affordability wizard (Results & Decision step).
//
// The website sends every input (application figures, verified affordability, loan-history behaviour flags and the
// Drive ids of the statements / payslips). This module refuses to run if anything is missing, downloads the documents,
// then runs the same pipeline as the n8n workflow and the trainer console:
//   parse -> metrics -> provisional rules engine -> LLM judgement calls + analyst note -> gated merge -> rules engine.
// The LLM never counts and never decides.
//
// Audit copy of every run: training/assessments/<applicationId>/<jobId>/ (payload, document text, analysis.json,
// llm-raw.json, result.json). These are NOT training cases; import them through the console if you want them labelled.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
const C = require('./server.js');
const { mergeObservations, repairJson, cleanNote } = require(path.join(C.ROOT, 'n8n/statement-analysis.js'));
const { scoreAssessment } = require(path.join(C.ROOT, 'n8n/scoring.js'));

const FRAMEWORK_VERSION = '2.2';
const FOLDER = 'application/vnd.google-apps.folder';
const BACKEND = (process.env.LLM_BACKEND || 'ollama').toLowerCase();
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const OLLAMA = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const OPENAI_URL = process.env.LLM_API_URL || 'http://localhost:8080';
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 6144);
const FALLBACK_NUM_CTX = Number(process.env.OLLAMA_FALLBACK_NUM_CTX || 8192);
const MAX_DOC_CHARS = Number(process.env.MAX_DOC_CHARS || 20000);
const LLM_TIMEOUT_MS = Number(process.env.ASSESSMENT_LLM_TIMEOUT_MS || 20 * 60 * 1000);
// Documents may only come from the applications root the website uploads into (the KYC folder, one app_<id> sub-folder
// per application). If set, a folder outside it is refused even when the payload claims otherwise.
const ROOT_FOLDER = process.env.GOOGLE_DRIVE_KYC_FOLDER_ID || process.env.GOOGLE_DRIVE_APPLICATIONS_FOLDER_ID || '';
const OUT = path.join(C.ROOT, 'training', 'assessments'); fs.mkdirSync(OUT, { recursive: true });

const REQUIRED_APP = ['id', 'applicant_name', 'loan_amount', 'interest_rate', 'income', 'expenses', 'existing_debt', 'loan_purpose', 'application_date'];
const NUMERIC_APP = ['loan_amount', 'interest_rate', 'income', 'expenses', 'existing_debt'];
const safe = s => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'x';
const blank = v => v === undefined || v === null || String(v).trim() === '';

// The website already refuses to queue an incomplete job; this is the worker's own guarantee that it never guesses.
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw Object.assign(new Error('Missing required input(s): payload'), { missing: ['payload'] });
  const missing = [];
  const app = payload.application;
  if (!app || typeof app !== 'object') missing.push('application');
  else {
    for (const k of REQUIRED_APP) if (blank(app[k])) missing.push(`application.${k}`);
    for (const k of NUMERIC_APP) if (!blank(app[k]) && !isFinite(Number(app[k]))) missing.push(`application.${k} (not a number)`);
  }
  if (blank(payload.folderId)) missing.push('folderId');
  const docs = payload.documents;
  if (!Array.isArray(docs) || docs.length === 0) missing.push('documents');
  else {
    docs.forEach((d, i) => { if (!d || blank(d.driveId)) missing.push(`documents[${i}].driveId`); if (!d || blank(d.name)) missing.push(`documents[${i}].name`); });
    if (!docs.some(d => d && d.kind === 'statement')) missing.push('documents: at least one bank statement');
  }
  if (missing.length) throw Object.assign(new Error('Missing required input(s): ' + missing.join(', ')), { missing });
  return payload;
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const lib = u.protocol === 'https:' ? https : http; const data = JSON.stringify(body);
    const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('LLM returned a non-JSON response: ' + d.slice(0, 200))); } }); });
    req.on('timeout', () => req.destroy(new Error(`LLM call timed out after ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject); req.end(data);
  });
}

// One call to the local model. Returns the parsed (repaired if truncated) JSON plus token / timing stats.
async function callLlm(system, user, { mode, log, num_predict: np, repeat_penalty }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const num_predict = np || (mode === 'deterministic' ? 350 : 1500), num_ctx = mode === 'deterministic' ? NUM_CTX : FALLBACK_NUM_CTX;
  const url = BACKEND === 'openai' ? `${OPENAI_URL}/v1/chat/completions` : `${OLLAMA}/api/chat`;
  const body = BACKEND === 'openai'
    ? { model: MODEL, messages, temperature: 0.1, max_tokens: num_predict, seed: 7, response_format: { type: 'json_object' }, stream: false }
    : { model: MODEL, messages, stream: false, format: 'json', keep_alive: '30m', options: Object.assign({ temperature: 0.1, num_ctx, num_predict, seed: 7 }, repeat_penalty ? { repeat_penalty } : {}) };
  log(`calling ${MODEL} (${BACKEND}, ${mode}, ~${Math.round((system.length + user.length) / 3.8)} prompt tokens)…`);
  const t0 = Date.now();
  const resp0 = await postJson(url, body, LLM_TIMEOUT_MS);
  if (resp0.error) throw new Error('LLM error: ' + (typeof resp0.error === 'string' ? resp0.error : JSON.stringify(resp0.error)));
  const resp = resp0.choices
    ? { message: resp0.choices[0].message, prompt_eval_count: resp0.usage && resp0.usage.prompt_tokens, eval_count: resp0.usage && resp0.usage.completion_tokens }
    : resp0;
  const raw = (resp.message && resp.message.content) || '';
  const seconds = Math.round((Date.now() - t0) / 10) / 100;
  let parsed; try { parsed = repairJson(raw); } catch (e) { throw new Error('LLM output was not JSON: ' + raw.slice(0, 300)); }
  log(`model done in ${seconds}s (${resp.prompt_eval_count || '?'} in / ${resp.eval_count || '?'} out${parsed.repaired ? ', JSON repaired' : ''})`);
  return { value: parsed.value || {}, raw, info: { prompt_tokens: resp.prompt_eval_count || null, output_tokens: resp.eval_count || null, seconds, json_repaired: !!parsed.repaired } };
}

// ctx: { log, jobId, driveMeta(id) -> {id,name,mimeType,size,parents}, downloadFile(id, dest), isCancelled() }
async function runAssessment(payloadIn, ctx) {
  const { log, jobId, driveMeta, downloadFile } = ctx; const isCancelled = ctx.isCancelled || (async () => false);
  const t0 = Date.now();
  const payload = validatePayload(payloadIn); const app = payload.application;
  const dir = path.join(OUT, safe(app.id), safe(jobId || Date.now()));
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(payload, null, 2));

  // ---- documents: only from the application's own folder, which must sit in the configured root ----
  const folder = await driveMeta(payload.folderId);
  if (folder.mimeType !== FOLDER) throw new Error(`folderId ${payload.folderId} is not a Drive folder`);
  const parents = folder.parents || [];
  if (ROOT_FOLDER && !parents.includes(ROOT_FOLDER)) throw new Error(`application folder "${folder.name}" is not inside the configured applications root`);
  if (payload.rootFolderId && !parents.includes(payload.rootFolderId)) throw new Error(`application folder "${folder.name}" is not inside the root the website expects`);
  const files = [];
  for (const d of payload.documents) {
    if (await isCancelled()) throw new Error('cancelled');
    const meta = await driveMeta(d.driveId);
    if (!(meta.parents || []).includes(folder.id)) throw new Error(`document "${d.name}" is not inside the application folder`);
    const name = meta.name || d.name; const dest = path.join(dir, 'src', safe(name));
    log(`downloading ${name} (${d.kind}${meta.size ? ', ' + (Number(meta.size) / 1e6).toFixed(1) + ' MB' : ''})…`);
    await downloadFile(meta.id, dest);
    files.push({ path: dest, originalName: name, hint: d.kind, cleanup: false });
  }

  // ---- parse + metrics + provisional findings (identical to the n8n Analyse node and the trainer console) ----
  log('parsing documents and computing metrics…');
  const a = C.ingestCase(app.id, files, app, { dir });
  const { A, opts, docCount, docs } = a.internal; const normApp = a.internal.app;
  const unreadable = (a.documents || []).filter(d => d.unreadable).map(d => d.original);
  if (unreadable.length) log(`unreadable (no text layer — scanned PDF?): ${unreadable.join(', ')}`);
  log(`parser ${a.mode}: ${a.parser.transactions} transactions; provisional ${a.findings.risk_rating} / ${a.findings.recommendation} / ${a.findings.expense_risk_tier}`);
  if (await isCancelled()) throw new Error('cancelled');

  // ---- LLM: judgement calls + analyst note (v2), or the v1 framework over raw text when nothing parsed ----
  let J = {}, llm = null, obs;
  const read = d => { try { return fs.readFileSync(path.join(dir, d.file), 'utf8'); } catch (e) { return ''; } };
  if (a.mode === 'deterministic') {
    const system = fs.readFileSync(path.join(C.ROOT, 'prompts/credit-assessment-judgement.md'), 'utf8');
    const user = 'VERIFIED METRICS AND STATEMENT LINES\n' + a.brief + '\n\nMake the judgement calls and write the narrative. Return ONLY the minified JSON object.';
    const r = await callLlm(system, user, { mode: 'deterministic', log });
    J = r.value; llm = r.info; fs.writeFileSync(path.join(dir, 'llm-raw.json'), r.raw);
    // Small models occasionally loop on a list until the token cap and never reach the note. The judgements are
    // already in hand (and gated), so ask once more for the narrative alone, with a repeat penalty. Never affects
    // the decision: the rules engine scores the metrics either way.
    if (!cleanNote(J.analyst_note || J.reasoning || '')) {
      log('analyst note missing (model output truncated) — asking once more for the note only…');
      const noteUser = user + '\n\nThe judgement calls are done. Return ONLY {"analyst_note":"..."} — a 40-80 word plain-English note for the file that explains the rules-engine findings. No lists, no other keys.';
      try {
        const r2 = await callLlm(system, noteUser, { mode: 'deterministic', log, num_predict: 160, repeat_penalty: 1.3 });
        fs.writeFileSync(path.join(dir, 'llm-raw-note.json'), r2.raw);
        const note = cleanNote(typeof r2.value.analyst_note === 'string' ? r2.value.analyst_note : (typeof r2.value.reasoning === 'string' ? r2.value.reasoning : ''));
        if (note) J.analyst_note = note;
        llm = Object.assign({}, llm, { note_retry: r2.info });
      } catch (e) { log('note retry failed: ' + e.message); }
    }
    obs = mergeObservations(A, J, opts);
  } else if (a.mode === 'fallback') {
    log('no statement parsed deterministically — v1 fallback (model reads the raw text; automatic approval is blocked)');
    const system = fs.readFileSync(path.join(C.ROOT, 'prompts/credit-assessment-framework.md'), 'utf8');
    const rawText = docs.map(d => `\n\n===== DOCUMENT: ${d.original} =====\n${read(d)}`).join('').slice(0, MAX_DOC_CHARS);
    const money = v => blank(v) ? 'not provided' : `$${Number(v).toLocaleString('en-NZ')}`;
    const user = `APPLICATION DATA\n- Application ID: ${app.id}\n- Applicant: ${app.applicant_name}\n- Requested amount: ${money(app.loan_amount)}\n- Interest rate: ${app.interest_rate}% p.a.\n- Declared monthly income: ${money(app.income)}\n- Declared monthly expenses: ${money(app.expenses)}\n- Existing debt: ${money(app.existing_debt)}\n- Stated purpose: ${app.loan_purpose}\n\nSUPPORTING DOCUMENTS (extracted text)${rawText}\n\nScreen the documents against the framework. Count, don't estimate. Return ONLY the JSON object described in Part C.`;
    const r = await callLlm(system, user, { mode: 'fallback', log });
    J = r.value; llm = r.info; fs.writeFileSync(path.join(dir, 'llm-raw.json'), r.raw);
    obs = J; if (!obs.reasoning) obs.reasoning = cleanNote(J.analyst_note || '');
  } else {
    obs = {};
  }
  if (await isCancelled()) throw new Error('cancelled');

  // ---- the rules engine decides ----
  const r = scoreAssessment(obs, normApp, { documentCount: docCount, parserMode: a.mode });
  const note = cleanNote(J.analyst_note || J.reasoning || obs.reasoning || '');
  const result = {
    application_id: app.id, reference: app.reference || null,
    risk_rating: r.risk_rating, recommendation: r.recommendation, confidence_score: r.confidence_score, escalation: r.escalation, pathway: r.pathway,
    expense_risk_tier: r.expense_risk_tier, behaviour_score: r.behaviour_score, behaviour_tier: r.behaviour_tier,
    factors: r.factors, reasoning: r.reasoning, analyst_note: note, evidence: r.evidence.slice(0, 20), data_gaps: r.data_gaps,
    rule_hits: r.rule_hits, affordability: r.affordability, llm_preliminary_view: r.llm_preliminary_view,
    parser_mode: a.mode,
    documents: (a.documents || []).map(d => ({ name: d.original, kind: d.kind, transactions: d.transactions || 0, unreadable: !!d.unreadable })),
    statement: a.mode === 'deterministic'
      ? { period_days: A.period ? (A.period.days ?? null) : null, transactions: a.parser.transactions, observed_net_monthly_income: A.income ? A.income.observed_net_monthly : null }
      : null,
    provisional: { risk_rating: a.findings.risk_rating, recommendation: a.findings.recommendation, expense_risk_tier: a.findings.expense_risk_tier },
    rejected_behaviour_ticks: obs.rejected_behaviour_ticks || [],
    model: MODEL, backend: BACKEND, framework_version: FRAMEWORK_VERSION, llm,
    processing_ms: Date.now() - t0, completed_at: new Date().toISOString(), audit_dir: path.relative(C.ROOT, dir),
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  log(`DECISION ${result.risk_rating} / ${result.recommendation} / ${result.expense_risk_tier} / behaviour ${result.behaviour_score} / confidence ${result.confidence_score} / escalation ${result.escalation} (${Math.round(result.processing_ms / 1000)} s)`);
  return result;
}

module.exports = { runAssessment, validatePayload, callLlm, MODEL, BACKEND, FRAMEWORK_VERSION };
