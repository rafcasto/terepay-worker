#!/usr/bin/env node
// Scores a model against the gold exam set. Same prompt as production; no n8n needed.
//   node training/run_exam.js [--model llama3.2:3b] [--n 12] [--exam training/out/exam.json] [--backend ollama|openai]
// Metrics per case: valid JSON, judgement precision/recall vs gold, behaviour F1, note length in range,
// note covers triggered findings, no contradictions, no invented numbers. Writes training/out/exam-<model>.json
const fs = require('fs'), path = require('path'), http = require('http');
const { repairJson, cleanNote, BEHAVIOUR_KEYS } = require('../n8n/statement-analysis.js');
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const model = opt('model', process.env.OLLAMA_MODEL || 'llama3.2:3b'); const N = Number(opt('n', 12)); const backend = opt('backend', process.env.LLM_BACKEND || 'ollama');
const examPath = opt('exam', path.join(__dirname, 'out', 'exam.json'));
const SYSTEM = fs.readFileSync(opt('system', path.join(__dirname, '..', 'prompts', 'credit-assessment-judgement.md')), 'utf8');
const tag = opt('tag', '');
const exam = JSON.parse(fs.readFileSync(examPath, 'utf8')).slice(0, N);
const base = backend === 'openai' ? (process.env.LLM_API_URL || 'http://localhost:8080') : (process.env.OLLAMA_API_URL || 'http://localhost:11434');

function call(system, user) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const url = backend === 'openai' ? `${base}/v1/chat/completions` : `${base}/api/chat`;
  const body = JSON.stringify(backend === 'openai' ? { model, messages, temperature: 0.1, max_tokens: 350, seed: 7, response_format: { type: 'json_object' }, stream: false }
    : { model, messages, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.1, num_ctx: 6144, num_predict: 350, seed: 7 } });
  return new Promise((resolve, reject) => {
    const u = new URL(url); const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1800000 },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { const j = JSON.parse(d); resolve(j.choices ? { content: j.choices[0].message.content, out: j.usage && j.usage.completion_tokens } : { content: j.message.content, out: j.eval_count, evalMs: (j.eval_duration || 0) / 1e6, promptMs: (j.prompt_eval_duration || 0) / 1e6 }); } catch (e) { reject(e); } }); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
}
const numsIn = t => new Set((String(t).match(/\$?\d[\d,]*(?:\.\d+)?%?/g) || []).map(x => x.replace(/[$,%]/g, '').replace(/\.0+$/, '')));
const CONTRA = [[/gambling/i, /\b(no|without|absence of)\s+(any\s+)?(gambling|betting)/i], [/BNPL/i, /\bno\s+(bnpl|buy.now)/i], [/Remittances/i, /\bno\s+(remittance|overseas transfer)/i], [/overdraft|dishonour|Zero balance/i, /\b(no|without)\s+(overdraft|dishonour|fees)/i], [/medical/i, /\bno\s+medical/i]];

(async () => {
  const results = []; let t0all = Date.now();
  for (const e of exam) {
    const t0 = Date.now(); let resp, J, valid = true, repaired = false;
    try { resp = await call(SYSTEM, e.user); const r = repairJson(resp.content); J = r.value; repaired = r.repaired; } catch (err) { valid = false; J = {}; resp = resp || {}; }
    const secs = (Date.now() - t0) / 1000;
    const gJ = e.gold.judgements || {}, mJ = (J && J.judgements) || {};
    const gKeys = Object.keys(gJ), mKeys = Object.keys(mJ).filter(k => typeof mJ[k] === 'boolean');
    const correct = mKeys.filter(k => k in gJ && gJ[k] === mJ[k]).length;
    const jPrec = mKeys.length ? correct / mKeys.length : null, jRec = gKeys.length ? correct / gKeys.length : null;
    const gB = new Set(e.gold.behaviour || []), mB = new Set((Array.isArray(J.behaviour) ? J.behaviour : []).filter(k => BEHAVIOUR_KEYS.includes(k)));
    const tp = [...mB].filter(k => gB.has(k)).length; const bF1 = (gB.size + mB.size) ? 2 * tp / (gB.size + mB.size) : 1;
    const note = cleanNote(J.analyst_note || J.reasoning || '');   // as stored in production
    const words = note.split(/\s+/).filter(Boolean).length;
    const lenOk = words >= 35 && words <= 95;
    const trig = e.triggered || []; const covered = trig.filter(t => { const k = t.match(/gambling|BNPL|Remittances|overdraft|Zero balance|medical|Income fell|family bailouts|credit facilities|under \$/i); return k && new RegExp(k[0].replace(/\$/g, '\\$').replace(/\s+/g, '\\s*'), 'i').test(note); }).length;
    const coverage = trig.length ? covered / trig.length : 1;
    const contradiction = CONTRA.some(([trigRe, negRe]) => trig.some(t => trigRe.test(t)) && negRe.test(note));
    const allowed = numsIn(e.user); const invented = [...numsIn(note)].filter(x => x.length >= 2 && !allowed.has(x) && !['20', '25', '30', '90', '100'].includes(x));
    const conclusionOk = e.decision.includes('Deny') ? /declin|hardship|not affordable|cannot afford/i.test(note) : e.decision.includes('Approve') ? /approv|affordable|no (indication|evidence) of hardship|without hardship/i.test(note) && !/declin/i.test(note) : /refer|credit officer|verify|manual review|conditional|reduced amount/i.test(note);
    results.push({ id: e.id, profile: e.profile, decision: e.decision, secs: +secs.toFixed(0), out_tokens: resp.out || null, valid, repaired, jPrec, jRec, mKeys: mKeys.length, bF1, words, lenOk, coverage: +coverage.toFixed(2), contradiction, invented, conclusionOk, note });
    console.log(`${e.id.padEnd(36)} ${e.decision.padEnd(28)} ${String(secs.toFixed(0) + 's').padStart(5)} json=${valid ? (repaired ? 'repaired' : 'ok') : 'FAIL'} judg P/R=${jPrec === null ? '-' : jPrec.toFixed(2)}/${jRec === null ? '-' : jRec.toFixed(2)} behav F1=${bF1.toFixed(2)} words=${words}${lenOk ? '' : '!'} cover=${coverage.toFixed(2)} ${contradiction ? 'CONTRADICTION ' : ''}${invented.length ? 'invented=' + invented.join(',') + ' ' : ''}${conclusionOk ? '' : 'CONCLUSION? '}`);
  }
  const avg = (k, f) => { const v = results.map(r => typeof f === 'function' ? f(r) : r[k]).filter(x => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const summary = { model, cases: results.length, avg_secs: +avg('secs').toFixed(0), json_valid: avg(null, r => r.valid ? 1 : 0), json_repaired: avg(null, r => r.repaired ? 1 : 0), judgement_precision: avg('jPrec'), judgement_recall: avg('jRec'), behaviour_f1: avg('bF1'), note_length_ok: avg(null, r => r.lenOk ? 1 : 0), finding_coverage: avg('coverage'), contradictions: avg(null, r => r.contradiction ? 1 : 0), invented_numbers: avg(null, r => r.invented.length ? 1 : 0), conclusion_consistent: avg(null, r => r.conclusionOk ? 1 : 0), total_min: +((Date.now() - t0all) / 60000).toFixed(1) };
  console.log('\nSUMMARY', JSON.stringify(summary, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(2) : v));
  fs.writeFileSync(path.join(path.dirname(examPath), `exam-${model.replace(/[:/]/g, '_')}${tag ? '-' + tag : ''}.json`), JSON.stringify({ summary, results }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
