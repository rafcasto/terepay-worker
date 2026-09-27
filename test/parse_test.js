// node parse_test.js <statement.txt> [application.json]  — parser + analytics only, no LLM
const fs = require('fs');
const { parseTransactions, analyseTransactions, buildLlmBrief, mergeObservations } = require('../n8n/statement-analysis.js');
const { scoreAssessment } = require('../n8n/scoring.js');
const text = fs.readFileSync(process.argv[2], 'utf8');
const app = JSON.parse(fs.readFileSync(process.argv[3] || 'sample-application.json', 'utf8'));
const p = parseTransactions(text);
const A = analyseTransactions(p.transactions);
const mode = process.argv[4] || 'summary';
if (mode === 'brief') { console.log(buildLlmBrief(A, app)); process.exit(0); }
if (mode === 'json') { console.log(JSON.stringify(A, null, 2)); process.exit(0); }
console.log(`parsed ${p.transactions.length} txns, opening ${p.opening_balance}, notes: ${p.notes.length ? p.notes.join(' | ') : 'none'}`);
const cats = {}; for (const t of p.transactions) cats[t.category] = (cats[t.category] || 0) + 1;
console.log('categories:', JSON.stringify(cats));
console.log('income:', A.income.observed_net_monthly, 'from', A.income.credits_count, 'credits', A.income.sources);
console.log('bnpl:', A.bnpl.transaction_count, 'txns', A.bnpl.monthly_spend, '/mo', A.bnpl.pct_of_income, '% max/wk', A.bnpl.max_per_week, A.bnpl.providers);
console.log('gambling:', A.gambling.any_activity, A.gambling.transaction_count, A.gambling.total_spend, A.gambling.operators);
console.log('remit:', A.remittances.count, A.remittances.monthly_total, '/mo', A.remittances.pct_of_income, '% under100:', A.remittances.sent_while_under_100_count, 'bnpl-basics:', A.remittances.sent_while_bnpl_for_basics);
console.log('cash:', JSON.stringify({ min: A.cash_flow.min_balance, u100: A.cash_flow.days_under_100_per_month, u50: A.cash_flow.days_under_50_per_month, u20: A.cash_flow.days_under_20_per_month, zero: A.cash_flow.zero_balance_events_per_month, fees: A.cash_flow.overdraft_or_dishonour_fees, nearZeroAfterPay: A.cash_flow.near_zero_after_pay_count, atmLow: A.cash_flow.atm_withdrawals_when_under_50, ge200pct: A.cash_flow.pct_days_at_or_above_200 }));
console.log('credit:', A.credit_dependency.active_credit_facilities, A.credit_dependency.facilities, 'family in:', A.credit_dependency.family_transfers_in, A.credit_dependency.family_bailout_frequency);
console.log('planning:', JSON.stringify({ buffer: A.financial_planning.buffer_200_maintained, fees: A.financial_planning.bank_fee_count, bills: A.financial_planning.recurring_bills, irregular: A.financial_planning.irregular_bills, regular: A.financial_planning.bill_payments_regular, cv: A.financial_planning.weekly_spend_cv }));
console.log('lifestyle:', JSON.stringify({ dining: A.lifestyle.dining_pct, ent: A.lifestyle.entertainment_pct, subs: A.lifestyle.subscriptions_count, life: A.lifestyle.lifestyle_pct }));
console.log('unclassified:', A.unclassified.map(t => t.desc + ' ' + t.amount).join(' | ') || 'none');
const r = scoreAssessment(mergeObservations(A, {}), app, { documentCount: 1 });
console.log(`\nRULES (no LLM): ${r.risk_rating} / ${r.recommendation} / tier ${r.expense_risk_tier}`);
for (const [k, v] of Object.entries(r.rule_hits)) if (v.length) console.log(`  ${k}:`, v.map(h => h.rule + (h.value !== true ? ` (${Array.isArray(h.value) ? h.value.join(',') : h.value})` : '')).join('; '));
