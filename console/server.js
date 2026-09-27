#!/usr/bin/env node
// TerePay Trainer Console — upload real cases (statements + payslips + history, singly or as a ZIP batch), label them, backtest, review gold notes, build the dataset,
// trigger a fine-tune on a GPU host, import the result into Ollama, run exams. Runs on the Pi (LAN only).
//   TRAINER_PASSWORD=... node console/server.js   (default port 8787)
const express = require('express'), multer = require('multer'), fs = require('fs'), path = require('path'), { spawn, execFileSync } = require('child_process'), http = require('http');
const ROOT = path.resolve(__dirname, '..');
const { parseTransactions, analyseTransactions, buildLlmBrief, mergeObservations, cleanNote, BEHAVIOUR_KEYS, looksLikePayslip, parsePayslip, summarisePayslips } = require(path.join(ROOT, 'n8n/statement-analysis.js'));
const { scoreAssessment } = require(path.join(ROOT, 'n8n/scoring.js'));
const T = p => path.join(ROOT, 'training', p);
const DIRS = { real: T('real'), reviews: T('reviews'), jobs: T('jobs'), out: T('out'), data: T('data') };
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
const SETTINGS = path.join(__dirname, 'settings.json');
const settings = () => fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : { gpu_mode: 'ssh', ssh_host: '', ssh_user: '', ssh_key: '', remote_dir: '~/terepay-finetune', base_model: 'unsloth/Llama-3.2-3B-Instruct', ollama_name: 'terepay-analyst', epochs: 2 };
const PASSWORD = process.env.TRAINER_PASSWORD || 'terepay';
const PORT = Number(process.env.TRAINER_PORT || 8787);
const OLLAMA = process.env.OLLAMA_API_URL || 'http://localhost:11434';

const app = express();
app.use((req, res, next) => {   // basic auth (LAN)
  const h = req.headers.authorization || ''; const [, b64] = h.split(' '); const pw = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (pw === PASSWORD) return next(); res.set('WWW-Authenticate', 'Basic realm="TerePay Trainer"'); res.status(401).send('Auth required');
});
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: path.join(DIRS.jobs, 'uploads'), limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ---------------- case analysis: statements (pooled) + payslips + history, same glue as the n8n Analyse node ----------------
const APP_FIELDS = ['applicant_name', 'loan_amount', 'interest_rate', 'income', 'expenses', 'existing_debt', 'loan_purpose', 'application_date', 'decision_made', 'decision_by', 'outcome', 'max_days_late', 'outcome_notes'];
const NUM_FIELDS = ['loan_amount', 'interest_rate', 'income', 'expenses', 'existing_debt', 'max_days_late'];
const OUTCOMES = ['repaid', 'repaid_late', 'arrears', 'default', 'written_off', 'current', 'declined', 'unknown'];
const BAD_OUTCOMES = ['arrears', 'default', 'written_off'];
function normOutcome(v) {
  const t = String(v || '').toLowerCase().trim(); if (!t) return 'unknown';
  if (/writ|charged|bad\s*debt/.test(t)) return 'written_off';
  if (/default/.test(t)) return 'default';
  if (/arrear|overdue|behind|delinq|hardship/.test(t)) return 'arrears';
  if (/late/.test(t)) return 'repaid_late';
  if (/repaid|paid|closed|complete|settled|finished/.test(t)) return 'repaid';
  if (/current|active|open|perform|ongoing|live/.test(t)) return 'current';
  if (/declin|reject|not approved|withdrawn|cancel/.test(t)) return 'declined';
  return OUTCOMES.includes(t) ? t : 'unknown';
}
function normDecision(v) { const t = String(v || '').toLowerCase().trim(); if (!t) return ''; if (/declin|reject|deny|denied/.test(t)) return 'declined'; if (/cond|reduc|partial/.test(t)) return 'conditional'; if (/approv|accept|funded|yes/.test(t)) return 'approved'; return t; }
const boolish = v => { if (typeof v === 'boolean') return v; const t = String(v ?? '').trim().toLowerCase(); if (['true', 'yes', 'y', '1', 'x'].includes(t)) return true; if (['false', 'no', 'n', '0'].includes(t)) return false; return null; };
function normaliseApp(appIn) {
  const app = { id: 'manual', applicant_name: 'Applicant' }; const src = appIn || {};
  for (const k of APP_FIELDS) if (src[k] !== undefined && src[k] !== null && String(src[k]).trim() !== '') app[k] = src[k];
  for (const k of NUM_FIELDS) app[k] = (app[k] === undefined || app[k] === '') ? null : Number(app[k]);
  for (const k of ['loan_amount', 'interest_rate', 'income', 'expenses', 'existing_debt']) if (app[k] !== null && !isFinite(app[k])) app[k] = null;
  app.outcome = normOutcome(src.outcome); app.decision_made = normDecision(src.decision_made);
  if (src.id) app.id = String(src.id);
  for (const k of BEHAVIOUR_KEYS) { const b = boolish(src['behaviour_' + k] ?? src[k]); if (b !== null) app['behaviour_' + k] = b; }   // TerePay loan-history columns, used as authoritative scorecard ticks
  return app;
}
function extractText(filePath, originalName) {
  if (/\.pdf$/i.test(originalName)) return execFileSync('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString();
  return fs.readFileSync(filePath, 'utf8');
}
// kind: statement | payslip | history | other. Content wins over the filename hint for statement/payslip.
function classifyDoc(name, text, hint) {
  const n = String(name || '').toLowerCase(); const p = parseTransactions(text);
  if (p.transactions.length >= 10) return { kind: 'statement', parsed: p };
  if (hint === 'payslip' || /pay-?slip|payroll|earnings|pay-?advice/.test(n) || looksLikePayslip(text)) return { kind: 'payslip', parsed: p };
  if (hint === 'history' || /history|credit|centrix|equifax|bureau|notes?|prior|previous|loan|record|conduct/.test(n)) return { kind: 'history', parsed: p };
  if (hint === 'statement' || /statement|txn|transaction/.test(n)) return { kind: 'statement', parsed: p };   // named as a statement but unparsed -> shows as "not parsed"
  return { kind: 'other', parsed: p };
}
// files: [{ path, originalName, hint }] ; writes <kind>-N.txt (+ .pdf copy), documents.json, application.json, analysis.json
function ingestCase(id, files, appIn, opts) {
  const dir = (opts || {}).dir || path.join(DIRS.real, id); if ((opts || {}).replace) fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const docs = []; const counters = {};
  for (const f of files) {
    let text = ''; try { text = extractText(f.path, f.originalName); } catch (e) { text = ''; }
    const c = classifyDoc(f.originalName, text, f.hint); counters[c.kind] = (counters[c.kind] || 0) + 1;
    const base = `${c.kind}-${counters[c.kind]}`; fs.writeFileSync(path.join(dir, base + '.txt'), text);
    if (/\.pdf$/i.test(f.originalName)) fs.copyFileSync(f.path, path.join(dir, base + '.pdf'));
    docs.push({ file: base + '.txt', original: f.originalName, kind: c.kind, chars: text.length, transactions: c.parsed.transactions.length, unreadable: text.trim().length === 0 });
    if (f.cleanup !== false) { try { fs.unlinkSync(f.path); } catch (e) {} }
  }
  writeJson(path.join(dir, 'documents.json'), docs);
  writeJson(path.join(dir, 'application.json'), normaliseApp(Object.assign({ id }, appIn)));
  return analyseCaseDir(dir, id);
}
function analyseCase(id) { return analyseCaseDir(path.join(DIRS.real, id), id); }
// dir holds documents.json + <kind>-N.txt + application.json; writes analysis.json. The non-enumerable `internal`
// property carries the in-memory metrics for callers that continue the pipeline (LLM judgement -> merge -> score).
function analyseCaseDir(dir, id) {
  const docs = readJson(path.join(dir, 'documents.json'), null) || (fs.existsSync(path.join(dir, 'statement.txt')) ? [{ file: 'statement.txt', original: 'statement.txt', kind: 'statement' }].concat(fs.existsSync(path.join(dir, 'history.txt')) ? [{ file: 'history.txt', original: 'history.txt', kind: 'history' }] : []) : []);
  const app = normaliseApp(Object.assign({ id }, readJson(path.join(dir, 'application.json'), {})));
  const read = d => { try { return fs.readFileSync(path.join(dir, d.file), 'utf8'); } catch (e) { return ''; } };
  const statements = [], others = [], payslips = [], seen = new Set(); let allTx = []; let datedLines = 0; const parserNotes = [];
  for (const d of docs) {
    const text = read(d); if (!text.trim()) continue;
    if (d.kind === 'payslip') { payslips.push(Object.assign({ fileName: d.original }, parsePayslip(text))); continue; }
    if (d.kind === 'history' || d.kind === 'other') { others.push({ fileName: d.original, text }); continue; }
    const p = parseTransactions(text);
    datedLines += text.split(/\r?\n/).filter(l => /^\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9})\b/.test(l)).length;
    if (p.transactions.length >= 10) {
      statements.push({ fileName: d.original, transactions: p.transactions.length, opening_balance: p.opening_balance, notes: p.notes });
      for (const t of p.transactions) { const k = t.date + '|' + t.line; if (!seen.has(k)) { seen.add(k); allTx.push(t); } }
      if (p.residual_text && p.residual_text.length > 120) others.push({ fileName: d.original + ' (notes)', text: p.residual_text });
      parserNotes.push(...p.notes.map(n => `${d.original}: ${n}`));
    } else { statements.push({ fileName: d.original, transactions: p.transactions.length, notes: p.notes.concat(['not parsed as a statement']) }); others.push({ fileName: d.original, text }); }
  }
  allTx.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const mode = allTx.length >= 10 ? 'deterministic' : (docs.length ? 'fallback' : 'none');
  const A = mode === 'deterministic' ? analyseTransactions(allTx) : { parser: { transaction_count: allTx.length, mode } };
  A.parser.mode = mode; A.parser.statements = statements;
  if (payslips.length) A.payslips = summarisePayslips(payslips, mode === 'deterministic' ? A : null, app);
  const otherText = others.map(d => `--- ${d.fileName} ---\n${d.text}`).join('\n\n').slice(0, 6000);
  const opts = { hasOtherDocs: otherText.length > 0, otherDocsText: otherText, dbBehaviour: app };
  const findings = mode === 'deterministic' ? scoreAssessment(mergeObservations(A, {}, opts), app, { documentCount: docs.length, parserMode: mode }) : scoreAssessment({ statement_summary: A.payslips ? { payslip_count: A.payslips.count, payslip_usable: A.payslips.usable, payslip_net_monthly: A.payslips.net_monthly, payslip_vs_declared_pct: A.payslips.vs_declared_pct } : {} }, app, { documentCount: docs.length, parserMode: mode });
  const brief = mode === 'deterministic' ? buildLlmBrief(A, app, otherText.trim(), findings) : null;
  const cats = {}; for (const t of allTx) cats[t.category || 'unparsed'] = (cats[t.category || 'unparsed'] || 0) + 1;
  const unclassified = allTx.filter(t => ['other_debit', 'other_credit', 'transfer_out'].includes(t.category)).map(t => ({ date: t.date, desc: t.desc, amount: t.amount }));
  const a = { mode, documents: docs, parser: { transactions: allTx.length, dated_lines_in_text: datedLines, statements, opening_balance: statements.length ? statements[0].opening_balance : null, notes: parserNotes, residual_chars: otherText.length }, categories: cats, unclassified: unclassified.slice(0, 40),
    payslips: A.payslips ? Object.assign({ slips: payslips }, A.payslips) : null,
    metrics: mode === 'deterministic' ? { period: A.period, income: A.income, bnpl: A.bnpl, cash_flow: A.cash_flow, credit: A.credit_dependency, gambling: A.gambling, remittances: A.remittances, medical: A.medical, lifestyle: A.lifestyle, planning: A.financial_planning } : null,
    findings: { risk_rating: findings.risk_rating, recommendation: findings.recommendation, expense_risk_tier: findings.expense_risk_tier, escalation: findings.escalation, behaviour_score: findings.behaviour_score, behaviour_tier: findings.behaviour_tier, rule_hits: findings.rule_hits, affordability: findings.affordability, factors: findings.factors, confidence: findings.confidence_score, header: findings.reasoning.split('\n\nANALYST')[0] },
    evidence: findings.evidence, brief, transactions: allTx.slice(0, 400), app, analysed_at: new Date().toISOString() };
  writeJson(path.join(dir, 'analysis.json'), a);
  Object.defineProperty(a, 'internal', { value: { A, opts, app, docCount: docs.length, otherText, docs }, enumerable: false });
  return a;
}
function summarise(id, a) {
  const label = readJson(path.join(DIRS.real, id, 'label.json'), null); const app = readJson(path.join(DIRS.real, id, 'application.json'), {});
  const kinds = {}; for (const d of (a.documents || [])) kinds[d.kind] = (kinds[d.kind] || 0) + 1;
  return { id, mode: a.mode, transactions: a.parser.transactions, dated_lines: a.parser.dated_lines_in_text, docs: kinds, decision: `${a.findings.risk_rating}/${a.findings.recommendation}/${a.findings.expense_risk_tier}`, income: a.metrics ? a.metrics.income.observed_net_monthly : null, payslip: a.payslips ? (a.findings.affordability || {}).payslip_status : null, unclassified: a.unclassified.length, labelled: !!label, outcome: app.outcome || 'unknown', decision_made: app.decision_made || '', notes: a.parser.notes.slice(0, 2) };
}

// ---------------- single case upload ----------------
app.post('/api/statements', upload.fields([{ name: 'file', maxCount: 20 }, { name: 'payslips', maxCount: 20 }, { name: 'history', maxCount: 5 }]), (req, res) => {
  try {
    const st = req.files.file || []; if (!st.length) return res.status(400).json({ error: 'at least one bank statement required' });
    const id = slug(req.body.application_id) || `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${slug(req.body.label || st[0].originalname.replace(/\.[^.]+$/, ''))}`;
    const files = st.map(f => ({ path: f.path, originalName: f.originalname, hint: 'statement' })).concat((req.files.payslips || []).map(f => ({ path: f.path, originalName: f.originalname, hint: 'payslip' })), (req.files.history || []).map(f => ({ path: f.path, originalName: f.originalname, hint: 'history' })));
    const a = ingestCase(id, files, req.body, { replace: !!req.body.application_id });
    res.json({ id, summary: summarise(id, a) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/statements', (req, res) => { const list = fs.readdirSync(DIRS.real).filter(d => fs.existsSync(path.join(DIRS.real, d, 'analysis.json'))).sort().reverse().map(id => summarise(id, readJson(path.join(DIRS.real, id, 'analysis.json'), {}))); res.json(list); });
app.get('/api/statements/:id', (req, res) => {
  const id = path.basename(req.params.id); const dir = path.join(DIRS.real, id); if (!fs.existsSync(dir)) return res.status(404).end();
  const a = readJson(path.join(dir, 'analysis.json'), null); const docs = (a && a.documents) || [];
  const text = docs.filter(d => d.kind === 'statement').map(d => { try { return `===== ${d.original} =====\n` + fs.readFileSync(path.join(dir, d.file), 'utf8'); } catch (e) { return ''; } }).join('\n\n').slice(0, 60000);
  res.json({ analysis: a, application: readJson(path.join(dir, 'application.json'), {}), label: readJson(path.join(dir, 'label.json'), null), text });
});
app.get('/api/statements/:id/doc/:file', (req, res) => { const f = path.join(DIRS.real, path.basename(req.params.id), path.basename(req.params.file)); if (!fs.existsSync(f)) return res.status(404).end(); res.type(/\.pdf$/.test(f) ? 'application/pdf' : 'text/plain').send(fs.readFileSync(f)); });
app.post('/api/statements/:id/reanalyse', (req, res) => { const id = path.basename(req.params.id); const dir = path.join(DIRS.real, id); if (!fs.existsSync(dir)) return res.status(404).end(); const appIn = normaliseApp(Object.assign({ id }, readJson(path.join(dir, 'application.json'), {}), req.body || {})); writeJson(path.join(dir, 'application.json'), appIn); const a = analyseCase(id); res.json({ analysis: a, application: appIn }); });
app.post('/api/statements/:id/label', (req, res) => { const dir = path.join(DIRS.real, path.basename(req.params.id)); const label = { judgements: req.body.judgements || {}, behaviour: (req.body.behaviour || []).filter(k => BEHAVIOUR_KEYS.includes(k)), analyst_note: cleanNote(req.body.analyst_note || ''), confidence: Number(req.body.confidence || 70), data_gaps: req.body.data_gaps || [], officer: req.body.officer || '', labelled_at: new Date().toISOString() }; writeJson(path.join(dir, 'label.json'), label); res.json({ ok: true }); });
app.delete('/api/statements/:id', (req, res) => { fs.rmSync(path.join(DIRS.real, path.basename(req.params.id)), { recursive: true, force: true }); res.json({ ok: true }); });

// ---------------- batch import: ZIP of one folder per application (+ optional applications.csv) ----------------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false; const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const hdr = (rows.shift() || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.filter(r => r.some(v => v.trim() !== '')).map(r => { const o = {}; hdr.forEach((h, i) => { if (h) o[h] = (r[i] || '').trim(); }); return o; });
}
const CSV_ALIASES = { application_id: ['application_id', 'id', 'app_id', 'loan_id', 'reference', 'ref', 'folder'], applicant_name: ['applicant_name', 'name', 'applicant', 'customer', 'borrower'], loan_amount: ['loan_amount', 'amount', 'requested_amount', 'principal'], interest_rate: ['interest_rate', 'rate', 'interest'], income: ['income', 'declared_income', 'monthly_income', 'net_income'], expenses: ['expenses', 'declared_expenses', 'monthly_expenses'], existing_debt: ['existing_debt', 'debt', 'other_debt'], loan_purpose: ['loan_purpose', 'purpose', 'reason'], application_date: ['application_date', 'date', 'applied', 'applied_at', 'created_at'], decision_made: ['decision_made', 'decision', 'terepay_decision', 'approved'], decision_by: ['decision_by', 'officer', 'assessor'], outcome: ['outcome', 'result', 'status', 'loan_status', 'performance'], max_days_late: ['max_days_late', 'days_late', 'days_in_arrears', 'dpd', 'max_dpd'], outcome_notes: ['outcome_notes', 'notes', 'comment', 'comments'] };
function rowToApp(row) {
  const o = {}; for (const [k, names] of Object.entries(CSV_ALIASES)) { const n = names.find(x => row[x] !== undefined && row[x] !== ''); if (n) o[k] = row[n]; }
  for (const k of BEHAVIOUR_KEYS) { const n = ['behaviour_' + k, 'behavior_' + k, k].find(x => row[x] !== undefined && row[x] !== ''); if (n) o['behaviour_' + k] = row[n]; }
  return o;
}
function walkFiles(dir) { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === '__MACOSX') continue; const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walkFiles(p)); else out.push(p); } return out; }
// Import every application folder under `root` (+ optional applications.csv). Pure function, used by the HTTP route and the queue worker.
function importBatchDir(root, opts) {
  const replace = !(opts && opts.replace === false); const log = (opts && opts.log) || (() => {});
  const top = fs.readdirSync(root).filter(n => !n.startsWith('.') && n !== '__MACOSX');
  if (top.length === 1 && fs.statSync(path.join(root, top[0])).isDirectory()) {   // single wrapper folder …
    const inner = path.join(root, top[0]); const innerHasDirs = fs.readdirSync(inner, { withFileTypes: true }).some(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');
    if (innerHasDirs) root = inner;   // … around a batch: descend
    // … holding only files: it IS the single case, keep root so the wrapper is imported under its own name
  }
  const csvFile = fs.readdirSync(root).find(n => /\.csv$/i.test(n) && /application|manifest|loans?|cases?|index/i.test(n)) || fs.readdirSync(root).find(n => /\.csv$/i.test(n) && !/statement|txn/i.test(n));
  const manifest = {}; let csvRows = 0;
  if (csvFile) for (const r of parseCsv(fs.readFileSync(path.join(root, csvFile), 'utf8'))) { const a = rowToApp(r); if (a.application_id) { manifest[slug(a.application_id)] = a; csvRows++; } }
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX').map(e => e.name);
  const results = []; let i = 0;
  for (const folder of folders) {
    const id = slug(folder); const fdir = path.join(root, folder); i++;
    try {
      const files = walkFiles(fdir).filter(f => /\.(pdf|txt|csv)$/i.test(f) && !/application\.json$/i.test(f)).map(f => ({ path: f, originalName: path.relative(fdir, f), cleanup: false, hint: undefined }));
      const appIn = Object.assign({}, manifest[id] || {}, readJson(path.join(fdir, 'application.json'), {}));
      if (!files.length && !Object.keys(appIn).length) { results.push({ id, status: 'skipped', reason: 'empty folder' }); continue; }
      if (!replace && fs.existsSync(path.join(DIRS.real, id, 'analysis.json'))) { results.push({ id, status: 'skipped', reason: 'exists' }); continue; }
      const a = ingestCase(id, files, appIn, { replace: true });
      const sm = summarise(id, a); results.push(Object.assign({ status: 'ok' }, sm)); log(`[${i}/${folders.length}] ${id}: ${sm.transactions} tx, ${sm.decision}`);
    } catch (e) { results.push({ id, status: 'failed', reason: e.message }); log(`[${i}/${folders.length}] ${id}: FAILED ${e.message}`); }
  }
  // manifest rows with no folder: outcome-only records (no documents) still count for the backtest of TerePay's own decisions
  let outcomeOnly = 0; for (const [id, a] of Object.entries(manifest)) if (!folders.some(f => slug(f) === id) && (a.outcome || a.decision_made)) { const dir = path.join(DIRS.real, id); if (fs.existsSync(path.join(dir, 'analysis.json'))) { writeJson(path.join(dir, 'application.json'), normaliseApp(Object.assign({ id }, readJson(path.join(dir, 'application.json'), {}), a))); analyseCase(id); outcomeOnly++; } }
  const counts = {}; for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { folders: folders.length, csv: csvFile || null, csv_rows: csvRows, outcomes_applied_to_existing: outcomeOnly, counts, results };
}
function importBatchZip(zipPath, opts) {
  const tmp = fs.mkdtempSync(path.join(DIRS.jobs, 'batch-'));
  try { execFileSync('unzip', ['-o', '-q', zipPath, '-d', tmp]); return importBatchDir(tmp, opts); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
app.post('/api/batch', upload.single('zip'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'zip file required' });
    const out = importBatchZip(req.file.path, { replace: String(req.body.replace || 'true') !== 'false' }); fs.unlinkSync(req.file.path); res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// CSV only: attach declared figures / outcomes to cases already uploaded (matched on application_id)
function importOutcomesCsv(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  let updated = 0; const missing = [];
  for (const r of rows) { const a = rowToApp(r); if (!a.application_id) continue; const id = slug(a.application_id); const dir = path.join(DIRS.real, id); if (!fs.existsSync(path.join(dir, 'analysis.json'))) { missing.push(id); continue; } writeJson(path.join(dir, 'application.json'), normaliseApp(Object.assign({ id }, readJson(path.join(dir, 'application.json'), {}), a))); analyseCase(id); updated++; }
  return { rows: rows.length, updated, missing };
}
app.post('/api/batch/outcomes', upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'csv file required' });
    const out = importOutcomesCsv(req.file.path); fs.unlinkSync(req.file.path); res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/batch/template.csv', (req, res) => { res.type('text/csv').attachment('applications.csv').send(fs.readFileSync(path.join(ROOT, 'training/templates/applications.csv'))); });

// ---------------- backtest: rules engine vs what actually happened ----------------
function computeBacktest() {
  const rows = [];
  for (const id of fs.readdirSync(DIRS.real)) { const a = readJson(path.join(DIRS.real, id, 'analysis.json'), null); const app = readJson(path.join(DIRS.real, id, 'application.json'), {}); if (!a || !a.findings) continue; rows.push({ id, tier: a.findings.expense_risk_tier, recommendation: a.findings.recommendation, risk: a.findings.risk_rating, mode: a.mode, decision_made: app.decision_made || '', outcome: app.outcome || 'unknown', max_days_late: app.max_days_late ?? null, loan_amount: app.loan_amount ?? null, purpose: app.loan_purpose || '', triggers: Object.entries(a.findings.rule_hits || {}).flatMap(([t, hs]) => (hs || []).map(h => `${t}:${h.rule}`)) }); }
  const known = rows.filter(r => r.outcome !== 'unknown' && r.outcome !== 'declined' && r.outcome !== 'current');   // funded loans with a resolved outcome
  const bucket = (arr, key) => { const m = {}; for (const r of arr) { const k = r[key] || '?'; m[k] = m[k] || { n: 0, bad: 0, repaid_late: 0 }; m[k].n++; if (BAD_OUTCOMES.includes(r.outcome)) m[k].bad++; if (r.outcome === 'repaid_late') m[k].repaid_late++; } for (const v of Object.values(m)) v.bad_rate = v.n ? +(v.bad / v.n * 100).toFixed(1) : null; return m; };
  const triggerStats = {}; for (const r of known) for (const t of new Set(r.triggers)) { triggerStats[t] = triggerStats[t] || { n: 0, bad: 0 }; triggerStats[t].n++; if (BAD_OUTCOMES.includes(r.outcome)) triggerStats[t].bad++; } for (const v of Object.values(triggerStats)) v.bad_rate = +(v.bad / v.n * 100).toFixed(1);
  const baseBad = known.length ? +(known.filter(r => BAD_OUTCOMES.includes(r.outcome)).length / known.length * 100).toFixed(1) : null;
  return { total: rows.length, with_outcome: known.length, base_bad_rate: baseBad, by_tier: bucket(known, 'tier'), by_recommendation: bucket(known, 'recommendation'), by_terepay_decision: bucket(rows.filter(r => r.outcome !== 'unknown'), 'decision_made'),
    triggers: Object.entries(triggerStats).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => Object.assign({ trigger: k }, v)),
    would_approve_but_bad: known.filter(r => r.recommendation === 'Approve' && BAD_OUTCOMES.includes(r.outcome)), would_deny_but_repaid: known.filter(r => r.recommendation === 'Deny' && r.outcome === 'repaid'),
    outcomes: Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(r => r.outcome === o).length])), rows };
}
app.get('/api/backtest', (req, res) => res.json(computeBacktest()));

// ---------------- gold review ----------------
const goldAll = () => readJson(path.join(DIRS.out, 'gold-all.json'), []);
const reviewOf = id => readJson(path.join(DIRS.reviews, id + '.json'), null);
app.get('/api/gold', (req, res) => { const all = goldAll(); const filt = req.query.profile ? all.filter(e => e.profile === req.query.profile) : all; const status = req.query.status; const rows = filt.map(e => { const r = reviewOf(e.id); return { id: e.id, profile: e.profile, decision: e.decision, status: r ? r.status : 'unreviewed', words: e.gold.analyst_note.split(/\s+/).length }; }).filter(r => !status || r.status === status); const counts = {}; for (const e of all) { const r = reviewOf(e.id); counts[r ? r.status : 'unreviewed'] = (counts[r ? r.status : 'unreviewed'] || 0) + 1; } res.json({ rows: rows.slice(0, 300), total: filt.length, counts, profiles: [...new Set(all.map(e => e.profile))] }); });
app.get('/api/gold/:id', (req, res) => { const e = goldAll().find(x => x.id === req.params.id); if (!e) return res.status(404).end(); res.json({ case: e, review: reviewOf(e.id) }); });
app.post('/api/gold/:id/review', (req, res) => { const e = goldAll().find(x => x.id === req.params.id); if (!e) return res.status(404).end(); const r = { status: req.body.status, gold: req.body.status === 'edited' ? { judgements: req.body.judgements || e.gold.judgements, behaviour: req.body.behaviour || e.gold.behaviour, analyst_note: cleanNote(req.body.analyst_note || e.gold.analyst_note), confidence: e.gold.confidence, data_gaps: e.gold.data_gaps } : e.gold, officer: req.body.officer || '', reviewed_at: new Date().toISOString() }; writeJson(path.join(DIRS.reviews, e.id + '.json'), r); res.json({ ok: true }); });

// ---------------- dataset build (synthetic gold + reviews + real labels) ----------------
function buildDataset() {
    const SYSTEM = fs.readFileSync(path.join(ROOT, 'prompts/credit-assessment-judgement.md'), 'utf8');
    const all = goldAll(); const examIds = new Set(readJson(path.join(DIRS.out, 'exam.json'), []).map(e => e.id));
    const lines = []; let synth = 0, edited = 0, rejected = 0, real = 0;
    for (const e of all) { if (examIds.has(e.id)) continue; const r = reviewOf(e.id); if (r && r.status === 'rejected') { rejected++; continue; } const gold = r && r.status === 'edited' ? r.gold : e.gold; if (r && r.status === 'edited') edited++; synth++; lines.push(JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: e.user }, { role: 'assistant', content: JSON.stringify(gold) }] })); }
    for (const id of fs.readdirSync(DIRS.real)) { const dir = path.join(DIRS.real, id); const label = readJson(path.join(dir, 'label.json'), null); const a = readJson(path.join(dir, 'analysis.json'), null); if (!label || !a || !a.brief) continue; const user = 'VERIFIED METRICS AND STATEMENT LINES\n' + a.brief + '\n\nMake the judgement calls and write the narrative. Return ONLY the minified JSON object.'; const gold = { judgements: label.judgements, behaviour: label.behaviour, analyst_note: label.analyst_note, confidence: label.confidence, data_gaps: label.data_gaps }; for (let k = 0; k < 3; k++) lines.push(JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }, { role: 'assistant', content: JSON.stringify(gold) }] })); real++; }   // real examples weighted x3
    fs.writeFileSync(path.join(DIRS.out, 'train.jsonl'), lines.join('\n') + '\n');
    const stats = { examples: lines.length, synthetic: synth, edited, rejected, real_labelled: real, exam_cases: examIds.size, built_at: new Date().toISOString() }; writeJson(path.join(DIRS.out, 'dataset-stats.json'), stats); return stats;
}
app.post('/api/dataset/build', (req, res) => { try { res.json(buildDataset()); } catch (e) { res.status(500).json({ error: e.message }); } });
function datasetInfo() { return { stats: readJson(path.join(DIRS.out, 'dataset-stats.json'), null), has_train: fs.existsSync(path.join(DIRS.out, 'train.jsonl')), has_exam: fs.existsSync(path.join(DIRS.out, 'exam.json')), reviews: fs.readdirSync(DIRS.reviews).length, real: fs.readdirSync(DIRS.real).filter(d => fs.existsSync(path.join(DIRS.real, d, 'label.json'))).length, real_cases: fs.readdirSync(DIRS.real).filter(d => fs.existsSync(path.join(DIRS.real, d, 'analysis.json'))).length }; }
app.get('/api/dataset', (req, res) => res.json(datasetInfo()));

// ---------------- jobs (fine-tune, exam, import) ----------------
const jobs = {};
function runJob(name, cmd, args, opts) {
  const id = `${Date.now()}-${name}`; const log = path.join(DIRS.jobs, id + '.log'); const out = fs.openSync(log, 'a');
  const child = spawn(cmd, args, Object.assign({ cwd: ROOT, stdio: ['ignore', out, out] }, opts || {}));
  jobs[id] = { id, name, cmd: [cmd, ...args].join(' '), pid: child.pid, started: new Date().toISOString(), status: 'running', log };
  Object.defineProperty(jobs[id], 'done', { enumerable: false, value: new Promise(resolve => child.on('exit', code => { jobs[id].status = code === 0 ? 'done' : 'failed'; jobs[id].code = code; jobs[id].ended = new Date().toISOString(); resolve(jobs[id]); })) });
  return jobs[id];
}
app.get('/api/jobs', (req, res) => res.json(Object.values(jobs).sort((a, b) => b.started.localeCompare(a.started))));
app.get('/api/jobs/:id/log', (req, res) => { const j = jobs[req.params.id]; if (!j) return res.status(404).end(); const t = fs.readFileSync(j.log, 'utf8'); res.type('text/plain').send(t.slice(-20000)); });
app.post('/api/jobs/:id/kill', (req, res) => { const j = jobs[req.params.id]; if (j && j.status === 'running') { try { process.kill(j.pid); } catch (e) {} } res.json({ ok: true }); });
app.get('/api/settings', (req, res) => { const s = settings(); s.local_gpu = fs.existsSync('/usr/bin/nvidia-smi'); res.json(s); });
app.post('/api/settings', (req, res) => { const s = Object.assign(settings(), req.body || {}); writeJson(SETTINGS, s); res.json(s); });
function startExam({ model, n, system } = {}) { const args = [path.join(ROOT, 'training/run_exam.js'), '--model', model || 'llama3.2:3b', '--n', String(n || 12)]; if (system) { args.push('--system', path.join(ROOT, 'prompts', path.basename(system)), '--tag', path.basename(system).replace(/\.md$/, '').replace('credit-assessment-judgement-', '')); } return runJob('exam', 'node', args); }
app.post('/api/jobs/exam', (req, res) => res.json(startExam(req.body || {})));
// Throws Error with .status = 400 for user-facing configuration problems.
function startFinetune(outNameIn) {
  const s = settings(); const outName = slug(outNameIn || s.ollama_name || 'terepay-analyst'); const bad = m => Object.assign(new Error(m), { status: 400 });
  if (!fs.existsSync(path.join(DIRS.out, 'train.jsonl'))) throw bad('Build the dataset first');
  const script = path.join(DIRS.jobs, 'finetune.sh');
  if (s.gpu_mode === 'local') {
    if (!fs.existsSync('/usr/bin/nvidia-smi')) throw bad('No NVIDIA GPU on this machine. Configure an SSH GPU host in Settings.');
    fs.writeFileSync(script, `#!/bin/bash\nset -euo pipefail\ncd ${ROOT}/training/finetune\npython3 train_lora.py --base "${s.base_model}" --data ../out/train.jsonl --out ${outName} --epochs ${s.epochs || 2}\ncd ${outName} && ollama create ${outName} -f Modelfile\necho FINETUNE_COMPLETE ${outName}\n`);
  } else {
    if (!s.ssh_host || !s.ssh_user) throw bad('Set SSH host and user in Settings (a machine with an NVIDIA GPU).');
    const key = s.ssh_key ? `-i ${s.ssh_key}` : ''; const dest = `${s.ssh_user}@${s.ssh_host}`; const rdir = s.remote_dir || '~/terepay-finetune';
    fs.writeFileSync(script, `#!/bin/bash\nset -euo pipefail\nSSH="ssh ${key} -o StrictHostKeyChecking=accept-new ${dest}"\necho "== checking GPU on ${dest}"; $SSH "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"\necho "== syncing training package"; $SSH "mkdir -p ${rdir}/out"\nrsync -az -e "ssh ${key}" ${ROOT}/training/finetune/ ${dest}:${rdir}/finetune/\nrsync -az -e "ssh ${key}" ${ROOT}/training/out/train.jsonl ${dest}:${rdir}/out/train.jsonl\nPY=${rdir}/venv/bin/python3\necho "== python venv + deps (first run only)"; $SSH "[ -x ${rdir}/venv/bin/python3 ] || python3 -m venv ${rdir}/venv; ${rdir}/venv/bin/python3 -c 'import torch, unsloth, trl, datasets' 2>/dev/null || { ${rdir}/venv/bin/pip install -q --upgrade pip && ${rdir}/venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cu128 && ${rdir}/venv/bin/pip install -q 'unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git' trl datasets; }"\necho "== training ${s.base_model} -> ${outName}"; $SSH "cd ${rdir}/finetune && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True UNSLOTH_CE_LOSS_TARGET_GB=1 ${rdir}/venv/bin/python3 train_lora.py --base '${s.base_model}' --data ../out/train.jsonl --out ${outName} --epochs ${s.epochs || 2} --max_seq ${s.max_seq || 2560}"\necho "== fetching GGUF (resumable, retries on Wi-Fi drops)"; mkdir -p ${DIRS.jobs}/models/${outName}; ok=0; for i in $(seq 1 30); do rsync -a --partial --append-verify --timeout=60 -e "ssh ${key}" ${dest}:${rdir}/finetune/${outName}/ ${DIRS.jobs}/models/${outName}/ --include='*.gguf' --include='Modelfile' --exclude='*' && { ok=1; break; }; echo "   transfer interrupted, resuming ($i/30)"; sleep 3; done; [ $ok = 1 ] || { echo "GGUF transfer failed after 30 attempts"; exit 1; }\necho "== importing into Ollama"; cd ${DIRS.jobs}/models/${outName} && ollama create ${outName} -f Modelfile\necho FINETUNE_COMPLETE ${outName}\n`);
  }
  fs.chmodSync(script, 0o755); return runJob('finetune', 'bash', [script]);
}
app.post('/api/jobs/finetune', (req, res) => { try { res.json(startFinetune((req.body || {}).out_name)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
app.post('/api/models/import', upload.single('gguf'), (req, res) => { try { const name = slug(req.body.name || 'terepay-analyst'); const dir = path.join(DIRS.jobs, 'models', name); fs.mkdirSync(dir, { recursive: true }); const g = path.join(dir, 'model.gguf'); fs.renameSync(req.file.path, g); fs.writeFileSync(path.join(dir, 'Modelfile'), `FROM ./model.gguf\nPARAMETER temperature 0.1\nPARAMETER num_ctx 6144\nPARAMETER num_predict 350\n`); res.json(runJob('import', 'ollama', ['create', name, '-f', 'Modelfile'], { cwd: dir })); } catch (e) { res.status(500).json({ error: e.message }); } });
function listModels() { return new Promise(resolve => { http.get(OLLAMA + '/api/tags', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d).models.map(m => ({ name: m.name, size_gb: +(m.size / 1e9).toFixed(2), modified: m.modified_at }))); } catch (e) { resolve([]); } }); }).on('error', () => resolve([])); }); }
app.get('/api/models', (req, res) => listModels().then(m => res.json(m)));
function listExams() { return fs.readdirSync(DIRS.out).filter(f => /^exam-.*\.json$/.test(f) && f !== 'exam.json').map(f => { const j = readJson(path.join(DIRS.out, f), {}); return Object.assign({ file: f }, j.summary || {}); }); }
app.get('/api/exams', (req, res) => res.json(listExams()));
app.get('/api/exams/:file', (req, res) => res.json(readJson(path.join(DIRS.out, path.basename(req.params.file)), {})));
app.get('/api/prompts', (req, res) => res.json(fs.readdirSync(path.join(ROOT, 'prompts')).filter(f => f.startsWith('credit-assessment-judgement'))));
function startRegenerate({ n, seed } = {}) { n = Number(n || 200); seed = Number(seed || 11); const script = path.join(DIRS.jobs, 'regen.sh'); fs.writeFileSync(script, `#!/bin/bash\nset -e\ncd ${ROOT}\nrm -rf training/data\nnode training/generate.js --n ${n} --seed ${seed} --out training/data\nnode training/eval_parser.js training/data\nnode training/build_gold.js training/data training/out\necho REGEN_COMPLETE\n`); fs.chmodSync(script, 0o755); return runJob('regenerate', 'bash', [script]); }
app.post('/api/synthetic/regenerate', (req, res) => res.json(startRegenerate(req.body || {})));

if (require.main === module) app.listen(PORT, '0.0.0.0', () => console.log(`TerePay Trainer Console on http://0.0.0.0:${PORT}  (user: any, password: ${process.env.TRAINER_PASSWORD ? '[from TRAINER_PASSWORD]' : 'terepay  <- set TRAINER_PASSWORD to change'})`));

// Used by console/worker.js (Upstash Redis queue driven by the TerePay admin site). Requiring this file does not start the HTTP server.
module.exports = { DIRS, ROOT, jobs, settings, goldAll, reviewOf, normaliseApp, cleanNote, BEHAVIOUR_KEYS, OUTCOMES, APP_FIELDS, writeSettings: v => writeJson(SETTINGS, v), importBatchDir, importBatchZip, importOutcomesCsv, computeBacktest, buildDataset, datasetInfo, startFinetune, startExam, startRegenerate, listModels, listExams, summarise, analyseCase, analyseCaseDir, ingestCase, extractText, classifyDoc, readJson, writeJson, slug };
