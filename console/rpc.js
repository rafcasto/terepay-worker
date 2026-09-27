// Request/reply handlers the website calls through Redis (see worker.js): small, synchronous, file-backed.
// Each returns plain JSON; sizes are trimmed so a reply fits comfortably in one Redis value.
'use strict';
const fs = require('fs'), path = require('path');
const C = require('./server.js');
const { DIRS } = C;
const bad = m => Object.assign(new Error(m), { status: 400 });
const caseDir = id => { const d = path.join(DIRS.real, path.basename(String(id || ''))); if (!id || !fs.existsSync(path.join(d, 'analysis.json'))) throw bad(`Unknown case: ${id}`); return d; };

const H = {
  'cases.list': () => fs.readdirSync(DIRS.real).filter(d => fs.existsSync(path.join(DIRS.real, d, 'analysis.json'))).sort().reverse().map(id => C.summarise(id, C.readJson(path.join(DIRS.real, id, 'analysis.json'), {}))),
  'cases.get': ({ id }) => {
    const dir = caseDir(id); const a = C.readJson(path.join(dir, 'analysis.json'), null) || {};
    const docs = a.documents || [];
    const text = docs.filter(d => d.kind === 'statement').map(d => { try { return `===== ${d.original} =====\n` + fs.readFileSync(path.join(dir, d.file), 'utf8'); } catch (e) { return ''; } }).join('\n\n').slice(0, 40000);
    const lite = Object.assign({}, a, { transactions: (a.transactions || []).slice(0, 150), unclassified: (a.unclassified || []).slice(0, 40) });
    return { id: path.basename(dir), analysis: lite, application: C.readJson(path.join(dir, 'application.json'), {}), label: C.readJson(path.join(dir, 'label.json'), null), text };
  },
  'cases.label': ({ id, label }) => {
    const dir = caseDir(id); const l = label || {};
    const judgements = {}; for (const [k, v] of Object.entries(l.judgements || {})) if (/^[a-z_]{3,60}$/.test(k) && typeof v === 'boolean') judgements[k] = v;
    const out = { judgements, behaviour: (Array.isArray(l.behaviour) ? l.behaviour : []).filter(k => C.BEHAVIOUR_KEYS.includes(k)), analyst_note: C.cleanNote(String(l.analyst_note || '')), confidence: Math.max(0, Math.min(100, Number(l.confidence || 70))), data_gaps: (Array.isArray(l.data_gaps) ? l.data_gaps : []).map(String).slice(0, 20), officer: String(l.officer || '').slice(0, 80), labelled_at: new Date().toISOString() };
    C.writeJson(path.join(dir, 'label.json'), out); return { ok: true, label: out };
  },
  'cases.reanalyse': ({ id, application }) => {
    const dir = caseDir(id); const cid = path.basename(dir);
    const app = C.normaliseApp(Object.assign({ id: cid }, C.readJson(path.join(dir, 'application.json'), {}), application || {}));
    C.writeJson(path.join(dir, 'application.json'), app); const a = C.analyseCase(cid);
    return { ok: true, summary: C.summarise(cid, a), application: app };
  },
  'cases.delete': ({ id }) => { const dir = caseDir(id); fs.rmSync(dir, { recursive: true, force: true }); return { ok: true }; },
  'backtest.get': () => { const b = C.computeBacktest(); return Object.assign({}, b, { rows: (b.rows || []).slice(0, 300), triggers: (b.triggers || []).slice(0, 60), would_approve_but_bad: (b.would_approve_but_bad || []).slice(0, 100), would_deny_but_repaid: (b.would_deny_but_repaid || []).slice(0, 100) }); },
  'gold.list': ({ profile, status } = {}) => {
    const all = C.goldAll(); const filt = profile ? all.filter(e => e.profile === profile) : all;
    const rows = filt.map(e => { const r = C.reviewOf(e.id); return { id: e.id, profile: e.profile, decision: e.decision, status: r ? r.status : 'unreviewed', words: String(e.gold.analyst_note || '').split(/\s+/).length }; }).filter(r => !status || r.status === status);
    const counts = {}; for (const e of all) { const r = C.reviewOf(e.id); const k = r ? r.status : 'unreviewed'; counts[k] = (counts[k] || 0) + 1; }
    return { rows: rows.slice(0, 300), total: filt.length, counts, profiles: [...new Set(all.map(e => e.profile))] };
  },
  'gold.get': ({ id }) => { const e = C.goldAll().find(x => x.id === id); if (!e) throw bad(`Unknown gold case: ${id}`); return { case: e, review: C.reviewOf(e.id) }; },
  'gold.review': ({ id, review }) => {
    const e = C.goldAll().find(x => x.id === id); if (!e) throw bad(`Unknown gold case: ${id}`); const rv = review || {};
    if (!['approved', 'edited', 'rejected'].includes(rv.status)) throw bad('status must be approved, edited or rejected');
    const r = { status: rv.status, gold: rv.status === 'edited' ? { judgements: rv.judgements || e.gold.judgements, behaviour: (rv.behaviour || e.gold.behaviour).filter(k => C.BEHAVIOUR_KEYS.includes(k)), analyst_note: C.cleanNote(String(rv.analyst_note || e.gold.analyst_note)), confidence: e.gold.confidence, data_gaps: e.gold.data_gaps } : e.gold, officer: String(rv.officer || '').slice(0, 80), reviewed_at: new Date().toISOString() };
    C.writeJson(path.join(DIRS.reviews, e.id + '.json'), r); return { ok: true, review: r };
  },
  'dataset.get': () => C.datasetInfo(),
  'exams.list': () => C.listExams().reverse(),
  'exams.get': ({ file }) => { const f = path.basename(String(file || '')); if (!/^exam-.*\.json$/.test(f)) throw bad('bad exam file'); const j = C.readJson(path.join(DIRS.out, f), null); if (!j) throw bad('not found'); return { file: f, summary: j.summary || {}, results: (j.results || []).slice(0, 60) }; },
  'settings.get': () => { const s = C.settings(); return Object.assign(s, { ssh_key: s.ssh_key ? '(set)' : '', local_gpu: fs.existsSync('/usr/bin/nvidia-smi') }); },
  'settings.set': ({ settings }) => {
    const cur = C.settings(); const inp = settings || {}; const out = Object.assign({}, cur);
    if (inp.gpu_mode !== undefined) { if (!['ssh', 'local'].includes(inp.gpu_mode)) throw bad('gpu_mode must be ssh or local'); out.gpu_mode = inp.gpu_mode; }
    for (const k of ['ssh_host', 'ssh_user', 'remote_dir', 'base_model', 'ollama_name']) if (typeof inp[k] === 'string') out[k] = inp[k].trim().slice(0, 200);
    if (typeof inp.ssh_key === 'string' && inp.ssh_key !== '(set)') out.ssh_key = inp.ssh_key.trim().slice(0, 300);
    if (inp.epochs !== undefined) { const n = Number(inp.epochs); if (!(n >= 1 && n <= 10)) throw bad('epochs must be 1–10'); out.epochs = n; }
    C.writeSettings(out); return H['settings.get']();
  },
  'prompts.list': () => fs.readdirSync(path.join(C.ROOT, 'prompts')).filter(f => f.startsWith('credit-assessment-judgement')),
  'ping': () => ({ pong: true, at: Date.now() }),
};
module.exports = { handle: (op, args) => { const h = H[op]; if (!h) throw bad(`Unknown op: ${op}`); return h(args || {}); }, ops: Object.keys(H) };
