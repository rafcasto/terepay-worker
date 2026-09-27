// End-to-end local test of the v2 pipeline (parse -> brief -> LLM judgement -> merge -> score), no n8n needed.
// node local_test.js [flagged|clean] [model] [--v1]     (--v1 = old LLM-counts-everything mode, for comparison)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { parseTransactions, analyseTransactions, buildLlmBrief, mergeObservations, repairJson } = require('../n8n/statement-analysis.js');
const { scoreAssessment } = require('../n8n/scoring.js');
const which = process.argv[2] || 'flagged';
const model = process.argv[3] || process.env.OLLAMA_MODEL || 'llama3.2:3b';
const v1 = process.argv.includes('--v1');
const base = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const app = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-application.json'), 'utf8'));
const text = fs.readFileSync(path.join(__dirname, `sample-statement-${which}.txt`), 'utf8');

// Split "statement" vs "other documents" exactly like the n8n node: a doc is a statement if >= 10 txns parse
const parsed = parseTransactions(text);
const isStatement = parsed.transactions.length >= 10;
const otherDocs = parsed.residual_text && parsed.residual_text.length > 120 ? parsed.residual_text : '';
const A = isStatement ? analyseTransactions(parsed.transactions) : { parser: { transaction_count: 0, mode: 'none' } };
const mode = v1 ? 'fallback' : (isStatement ? 'deterministic' : 'fallback');

let system, user, num_ctx;
if (mode === 'deterministic') {
  system = fs.readFileSync(path.join(ROOT, 'prompts/credit-assessment-judgement.md'), 'utf8');
  const findings = scoreAssessment(mergeObservations(A, {}, { hasOtherDocs: !!otherDocs, otherDocsText: otherDocs, dbBehaviour: app }), app, { documentCount: 1, parserMode: mode });
  console.log(`provisional (rules only): ${findings.risk_rating} / ${findings.recommendation} / ${findings.expense_risk_tier}`);
  user = 'VERIFIED METRICS AND STATEMENT LINES\n' + buildLlmBrief(A, app, otherDocs, findings) + '\n\nMake the judgement calls and write the narrative. Return ONLY the minified JSON object.';
  num_ctx = Number(process.env.OLLAMA_NUM_CTX || 4096);
} else {
  system = fs.readFileSync(path.join(ROOT, 'prompts/credit-assessment-framework.md'), 'utf8');
  user = `APPLICATION DATA\n- Applicant: ${app.applicant_name}\n- Requested amount: $${app.loan_amount}\n- Interest rate: ${app.interest_rate}% p.a.\n- Declared monthly income: $${app.income}\n- Declared monthly expenses: $${app.expenses}\n- Existing debt: $${app.existing_debt}\n\nSUPPORTING DOCUMENTS (extracted text)\n\n===== DOCUMENT: bank-statement.pdf =====\n${text}\n\nScreen the documents against the framework. Count, don't estimate. Return ONLY the JSON object described in Part C.`;
  num_ctx = Number(process.env.OLLAMA_NUM_CTX || 8192);
}
const est = Math.round((system.length + user.length) / 3.8);
console.log(`mode=${mode} model=${model} sample=${which} prompt_chars=${system.length + user.length} (~${est} tokens) num_ctx=${num_ctx}`);

(async () => {
  const t0 = Date.now();
  const backend = (process.env.LLM_BACKEND || 'ollama').toLowerCase();
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const num_predict = mode === 'deterministic' ? 350 : 1500;
  const url = backend === 'openai' ? `${process.env.LLM_API_URL || 'http://localhost:8080'}/v1/chat/completions` : `${base}/api/chat`;
  const body = JSON.stringify(backend === 'openai'
    ? { model, messages, temperature: 0.1, max_tokens: num_predict, seed: 7, response_format: { type: 'json_object' }, stream: false }
    : { model, messages, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.1, num_ctx, num_predict, seed: 7 } });
  console.log(`backend=${backend} url=${url}`);
  const resp0 = await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require('http').request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 3600000 },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad response: ' + d.slice(0, 200))); } }); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
  // normalise Ollama / OpenAI-compatible responses
  const resp = resp0.choices ? { message: resp0.choices[0].message, prompt_eval_count: resp0.usage && resp0.usage.prompt_tokens, eval_count: resp0.usage && resp0.usage.completion_tokens,
      prompt_eval_duration: resp0.timings ? resp0.timings.prompt_ms * 1e6 : null, eval_duration: resp0.timings ? resp0.timings.predicted_ms * 1e6 : null } : resp0;
  if (resp0.error) { console.error('LLM error:', JSON.stringify(resp0.error)); process.exit(1); }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const rate = resp.eval_count && resp.eval_duration ? (resp.eval_count / (resp.eval_duration / 1e9)).toFixed(1) : '?';
  const prate = resp.prompt_eval_count && resp.prompt_eval_duration ? (resp.prompt_eval_count / (resp.prompt_eval_duration / 1e9)).toFixed(1) : '?';
  console.log(`LLM done in ${secs}s  prompt_tokens=${resp.prompt_eval_count} (${prate} tok/s)  output_tokens=${resp.eval_count} (${rate} tok/s)`);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const tag = `${which}-${model.replace(/[:/]/g, '_')}-${mode}-${backend}`;
  const raw = (resp.message && resp.message.content) || '';
  fs.writeFileSync(path.join(__dirname, 'out', `${tag}-llm.json`), raw);
  let J, repaired = false; try { const r = repairJson(raw); J = r.value; repaired = r.repaired; } catch (e) { console.error('LLM output not JSON:', raw.slice(0, 500)); process.exit(1); }
  if (repaired) console.log('  (JSON was truncated and repaired)');
  const obs = mode === 'deterministic' ? mergeObservations(A, J, { hasOtherDocs: !!otherDocs, otherDocsText: otherDocs, dbBehaviour: app }) : J;
  const r = scoreAssessment(obs, app, { documentCount: 1, parserMode: mode });
  fs.writeFileSync(path.join(__dirname, 'out', `${tag}-scored.json`), JSON.stringify(r, null, 2));
  console.log(`\nDECISION: ${r.risk_rating} / ${r.recommendation} / expense tier ${r.expense_risk_tier} / behaviour ${r.behaviour_score} (${r.behaviour_tier}) / confidence ${r.confidence_score} / escalation ${r.escalation}`);
  for (const [k, v] of Object.entries(r.rule_hits)) if (v.length) console.log(`  ${k}:`, v.map(h => h.rule + (h.value !== true ? ` (${Array.isArray(h.value) ? h.value.join(',') : h.value})` : '')).join('; '));
  console.log('  model judgements:', JSON.stringify(J.judgements || {}), '| accepted after gating:', JSON.stringify({ credit_paying_credit: obs.credit_dependency && obs.credit_dependency.credit_paying_credit, bnpl_essentials: obs.bnpl && obs.bnpl.used_for_essentials, remit_bnpl_basics: obs.remittances && obs.remittances.sent_while_bnpl_for_basics, undisclosed_oblig: obs.remittances && obs.remittances.undisclosed_obligation, chaotic: obs.financial_planning && obs.financial_planning.chaotic_spending }));
  console.log('  behaviour ticks (model):', JSON.stringify(J.behaviour || []), '| accepted:', Object.keys(obs.behaviour_scorecard || {}).join(', ') || 'none');
  console.log('  engine factors:', r.factors.length, '| data_gaps:', JSON.stringify(J.data_gaps || []), '| confidence:', J.confidence);
  console.log('\nANALYST NOTE (' + String(J.analyst_note || J.reasoning || '').split(/\s+/).length + ' words):\n' + (J.analyst_note || J.reasoning || ''));
  console.log('\nEVIDENCE (deterministic):\n' + r.evidence.slice(0, 6).map(e => '  ' + e).join('\n'));
  console.log(`\nTOTAL wall time incl. parsing: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch(e => { console.error(e); process.exit(1); });
