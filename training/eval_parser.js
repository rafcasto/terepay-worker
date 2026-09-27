#!/usr/bin/env node
// Parser + rules regression over the synthetic set.
//   node training/eval_parser.js [training/data]
// Checks: metrics vs ground truth (per layout), and layout invariance (same case, 5 layouts -> same decision).
const fs = require('fs'), path = require('path');
const { parseTransactions, analyseTransactions, mergeObservations } = require('../n8n/statement-analysis.js');
const { scoreAssessment } = require('../n8n/scoring.js');
const root = process.argv[2] || path.join(__dirname, 'data');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
const within = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol;
const stats = { cases: 0, layouts: 0, txCountExact: 0, income5pct: 0, bnplExact: 0, gamblingExact: 0, remitTotal2pct: 0, feesExact: 0, medicalExact: 0, invariant: 0, parseFail: 0 };
const byLayout = {}; const byProfile = {}; const decisions = {}; const failures = []; const ruleHits = {};
for (const c of cases) {
  const dir = path.join(root, c.id); const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8')); const app = JSON.parse(fs.readFileSync(path.join(dir, 'application.json'), 'utf8'));
  stats.cases++; const outcomes = new Set(); const perLayout = {};
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('statement-'))) {
    const L = f.replace('statement-', '').replace('.txt', ''); byLayout[L] = byLayout[L] || { n: 0, txExact: 0, income: 0, bnpl: 0, gambling: 0, remit: 0, fees: 0, medical: 0 };
    const text = fs.readFileSync(path.join(dir, f), 'utf8'); const p = parseTransactions(text);
    stats.layouts++; byLayout[L].n++;
    if (p.transactions.length < 10) { stats.parseFail++; failures.push(`${c.id}/${L}: only ${p.transactions.length} txns parsed`); continue; }
    const A = analyseTransactions(p.transactions);
    const other = p.residual_text && p.residual_text.length > 120 ? p.residual_text : '';
    const r = scoreAssessment(mergeObservations(A, {}, { hasOtherDocs: !!other, otherDocsText: other }), app, { documentCount: 1, parserMode: 'deterministic' });
    const key = `${r.risk_rating}/${r.recommendation}/${r.expense_risk_tier}`; outcomes.add(key); perLayout[L] = key;
    if (L === 'anz') { ruleHits[c.profile] = ruleHits[c.profile] || {}; for (const [tier, arr] of Object.entries(r.rule_hits)) for (const h of arr) { const k = `${tier[0].toUpperCase()}:${h.rule.slice(0, 48)}`; ruleHits[c.profile][k] = (ruleHits[c.profile][k] || 0) + 1; } }
    const ok = {
      tx: p.transactions.length === truth.transactions, income: within(A.income.observed_net_monthly, truth.income_monthly, truth.income_monthly * 0.05) || (truth.drop && A.income.observed_net_monthly < truth.income_monthly),   // drop cases: parser reports current (reduced) pay
      bnpl: A.bnpl.transaction_count === truth.bnpl, gambling: A.gambling.transaction_count === truth.gambling,
      remit: within(A.remittances.total, truth.remit_total, Math.max(1, truth.remit_total * 0.02)), fees: A.cash_flow.overdraft_or_dishonour_fees === truth.fees,
      medical: (A.medical ? A.medical.transaction_count : 0) === truth.medical,
    };
    if (ok.tx) { stats.txCountExact++; byLayout[L].txExact++; } if (ok.income) { stats.income5pct++; byLayout[L].income++; } if (ok.bnpl) { stats.bnplExact++; byLayout[L].bnpl++; }
    if (ok.gambling) { stats.gamblingExact++; byLayout[L].gambling++; } if (ok.remit) { stats.remitTotal2pct++; byLayout[L].remit++; } if (ok.fees) { stats.feesExact++; byLayout[L].fees++; } if (ok.medical) { stats.medicalExact++; byLayout[L].medical++; }
    const miss = Object.entries(ok).filter(([k, v]) => !v).map(([k]) => k);
    if (miss.length && failures.length < 400) failures.push(`${c.id}/${L}: ${miss.join(',')} | parsed tx ${p.transactions.length}/${truth.transactions} income ${A.income.observed_net_monthly}/${truth.income_monthly} (${A.income.cadence}) bnpl ${A.bnpl.transaction_count}/${truth.bnpl} gamb ${A.gambling.transaction_count}/${truth.gambling} remit ${A.remittances.total}/${truth.remit_total} fees ${A.cash_flow.overdraft_or_dishonour_fees}/${truth.fees} med ${A.medical ? A.medical.transaction_count : 0}/${truth.medical}${p.notes.length ? ' | ' + p.notes.slice(0, 2).join('; ') : ''}`);
  }
  if (outcomes.size === 1) stats.invariant++; else failures.push(`${c.id}: LAYOUT DIVERGENCE ${JSON.stringify(perLayout)}`);
  const first = [...outcomes][0]; byProfile[c.profile] = byProfile[c.profile] || {}; byProfile[c.profile][first] = (byProfile[c.profile][first] || 0) + 1; decisions[first] = (decisions[first] || 0) + 1;
}
const pc = (a, b) => `${(100 * a / b).toFixed(1)}%`;
console.log(`cases ${stats.cases}, statements ${stats.layouts}, parse failures ${stats.parseFail}`);
console.log(`metric accuracy  tx-count exact ${pc(stats.txCountExact, stats.layouts)} | income ±5% ${pc(stats.income5pct, stats.layouts)} | BNPL exact ${pc(stats.bnplExact, stats.layouts)} | gambling exact ${pc(stats.gamblingExact, stats.layouts)} | remittances ±2% ${pc(stats.remitTotal2pct, stats.layouts)} | fees exact ${pc(stats.feesExact, stats.layouts)} | medical exact ${pc(stats.medicalExact, stats.layouts)}`);
console.log(`layout invariance (same decision across all layouts): ${pc(stats.invariant, stats.cases)}`);
console.log('per layout:'); for (const [L, v] of Object.entries(byLayout)) console.log(`  ${L.padEnd(9)} tx ${pc(v.txExact, v.n)}  income ${pc(v.income, v.n)}  bnpl ${pc(v.bnpl, v.n)}  gamb ${pc(v.gambling, v.n)}  remit ${pc(v.remit, v.n)}  fees ${pc(v.fees, v.n)}  med ${pc(v.medical, v.n)}`);
console.log('decisions by profile:'); for (const [p, d] of Object.entries(byProfile)) console.log(`  ${p.padEnd(20)} ${Object.entries(d).map(([k, n]) => `${k} x${n}`).join(', ')}`);
console.log('most frequent rule hits per profile (ANZ layout):'); for (const [p, h] of Object.entries(ruleHits)) { const n = byProfile[p] ? Object.values(byProfile[p]).reduce((a, b) => a + b, 0) : 1; console.log(`  ${p}: ` + Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${Math.round(100 * v / n)}%`).join(' | ')); }
fs.writeFileSync(path.join(root, 'eval-failures.txt'), failures.join('\n'));
console.log(`${failures.length} issues logged -> ${path.join(root, 'eval-failures.txt')}`); console.log(failures.slice(0, 12).join('\n'));
