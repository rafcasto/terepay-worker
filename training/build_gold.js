#!/usr/bin/env node
// Builds gold labels + training/exam data from the synthetic set.
//   node training/build_gold.js [training/data] [training/out]
// For every case (ANZ layout as the canonical text) it produces exactly what production sends to the model
// (system prompt + brief) and the gold answer: corroborated judgement booleans, behaviour ticks from the
// history document, a credit-officer-style analyst note, confidence and data gaps.
// Notes are composed from case facts with varied, hand-written phrasing (Claude-authored templates) and never
// mention a number that isn't in the brief. A credit officer should spot-check ~10% before training.
const fs = require('fs'), path = require('path');
const { parseTransactions, analyseTransactions, buildLlmBrief, mergeObservations } = require('../n8n/statement-analysis.js');
const { scoreAssessment } = require('../n8n/scoring.js');
const root = process.argv[2] || path.join(__dirname, 'data'); const out = process.argv[3] || path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const SYSTEM = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'credit-assessment-judgement.md'), 'utf8');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));

// deterministic "random" per case id so phrasing varies but stays reproducible
const hash = s => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const pickFor = (id, salt, arr) => arr[(hash(id + salt)) % arr.length];
const $ = v => '$' + Math.round(Number(v)).toLocaleString('en-NZ');
const pct = v => `${Math.round(Number(v))}%`;

// ---------------- gold judgements (only what the evidence supports; unknown -> omitted) ----------------
function goldJudgements(A, app, truth, other) {
  const J = {};
  const inc = A.income.observed_net_monthly, decl = Number(app.income);
  if (inc && decl) J.income_matches_declared = Math.abs(inc - decl) / decl <= 0.2;
  if (A.remittances.count >= 3) {
    // steady if amounts/gaps are regular (synthetic remittances are paid on payday -> steady); crisis-driven only when spiky
    const amounts = (A.flagged_lines.remittances || []).length; J.remittances_crisis_driven = A.remittances.rising_over_time === true && A.remittances.count <= 4;
    // undisclosed_obligation is not knowable from synthetic data -> deliberately omitted (model should leave it out too)
  }
  if (A.bnpl.transaction_count >= 4) J.bnpl_cycling = A.bnpl.providers.length >= 2 && A.credit_dependency.cash_advances_or_topups >= 1;
  if (A.credit_dependency.cash_advances_or_topups >= 1) J.credit_paying_credit = A.credit_dependency.advance_then_repayment_same_week >= 1;
  if (A.financial_planning.weekly_spend_cv !== null) J.chaotic_spending = A.financial_planning.weekly_spend_cv > 0.9;
  if (A.lifestyle.luxury_txns.length) J.luxury_on_low_income = inc < 4000;
  if (A.lifestyle.rideshare_count >= 4) J.transport_beyond_need = A.lifestyle.rideshare_monthly > 150;
  return J;
}
function goldBehaviour(other) {
  const t = String(other || ''); const b = [];
  if (/repaid in full .* early/i.test(t)) b.push('paid_previous_loan_early');
  if (/all instalments paid on time/i.test(t)) b.push('paid_on_time_consistently');
  if (/emailed ahead|called to explain/i.test(t)) b.push('communicates_proactively');
  if (/missed payment/i.test(t)) b.push('missed_payments_before');
  if (/default was listed/i.test(t)) b.push('existing_defaults');
  if (/did not respond/i.test(t)) b.push('avoids_communication');
  if (/requested a top-up/i.test(t)) b.push('requests_bigger_loan_too_fast');
  return b;
}

// ---------------- analyst note (40-80 words; explanation + affordability + conclusion; no new numbers) ----------------
function goldNote(id, A, app, r, truth, other) {
  const hits = r.rule_hits; const H = [].concat(hits.immediate_decline, hits.critical, hits.high, hits.moderate).map(h => h.rule);
  const has = re => H.some(h => re.test(h));
  const inc = A.income.observed_net_monthly; const surplus = r.affordability.declared_surplus;
  const remitOk = A.remittances.count >= 2 && A.remittances.pct_of_income < 25;
  const parts = [];
  // 1) explanation / context for triggered findings
  if (has(/gambling/i)) parts.push(pickFor(id, 'g', ['The gambling transactions are small individually but the policy treats any betting activity as an immediate decline, and they coincide with the account running low.', 'Betting activity is present on the statement; under TerePay policy this is an immediate decline regardless of the amounts involved.', 'The TAB and online betting lines are unambiguous and fall under the zero-tolerance rule; no reasonable explanation changes that.']));
  if (has(/Daily BNPL|BNPL >/i)) parts.push(pickFor(id, 'b', ['Buy-now-pay-later repayments run several times a week across more than one provider, which is the pattern the policy associates with dependence rather than convenience.', 'The BNPL frequency points to instalments being used to bridge ordinary living costs rather than occasional purchases.', 'Frequent BNPL instalments to multiple providers indicate the customer is already committed well ahead of each pay.']));
  if (has(/Remittances > 25/i)) parts.push(pickFor(id, 'r', ['Regular transfers overseas are a normal and expected commitment for this customer; the concern is only that they are large enough to leave no buffer for a new repayment.', 'Supporting family overseas is consistent and not in itself a problem, but at this level it absorbs the capacity a further loan would need.', 'The remittances are steady rather than crisis-driven, so they should be treated as a fixed commitment when assessing affordability.']));
  else if (remitOk && A.remittances.pct_of_income >= 5) parts.push(pickFor(id, 'r2', ['Remittances are regular and modest and should be treated as a normal fixed commitment, not a risk factor.', 'Money sent to family overseas is consistent and affordable at this income level.']));
  if (has(/medical|Medical/i)) parts.push(pickFor(id, 'm', ['The stated purpose is medical and the statement shows the episode is ongoing; the key question is whether income holds up while treatment continues, and that should be verified with the employer or ACC before approval.', 'Medical costs are visible on the statement and the loan would cover the same episode; confirm whether the customer is still working full hours and what the remaining treatment cost is.', 'An unplanned medical expense is the reason for the application; TerePay\'s experience is that these loans fail when income falls during recovery, so income continuity needs confirming.']));
  if (has(/Income fell/i)) parts.push(pickFor(id, 'i', ['Pay credits in the most recent weeks are lower than earlier in the statement, which suggests reduced hours or time off work; the repayment should be assessed on the reduced figure.', 'Income has dropped in the latest month; unless the customer can show it has recovered, affordability must be assessed on the lower amount.']));
  if (has(/family bailouts/i)) parts.push(pickFor(id, 'f', ['Transfers from family arrive when the balance is close to zero, which indicates the household is already relying on outside help to get through the pay cycle.', 'Emergency top-ups from relatives are frequent, showing the current budget does not close without help.']));
  if (has(/3\+ active credit/i)) parts.push(pickFor(id, 'c', ['Several credit facilities are already being serviced from this account, and a further loan would add to a repayment load that is already crowding out essentials.', 'The number of existing lenders being paid each cycle leaves little room for an additional commitment.']));
  if (has(/overdraft|dishonour|Zero balance|under \$/i) && !has(/gambling/i)) parts.push(pickFor(id, 'o', ['The account is regularly overdrawn with dishonour fees, so the customer is already short before any new repayment.', 'Dishonour and overdraft fees show payments are already failing at the current level of commitments.', 'The balance sits under $100 for much of the month and payments have bounced; there is no cushion for a new instalment.']));
  if (!parts.length) parts.push(pickFor(id, 'z', ['Spending is steady and proportionate to income, bills are paid on schedule and the account holds a buffer through the cycle.', 'The statement shows disciplined spending, regular bill payments and a buffer maintained through each pay period.', 'Nothing on the statement suggests strain: essentials are covered, savings transfers are made and there are no fees.']));
  // 2) affordability - chosen from the balance metrics, not from the recommendation
  const cf = A.cash_flow || {}; const retained = (cf.pct_days_at_or_above_200 || 0) >= 50 && (cf.days_under_100_per_month || 0) < 5;
  let aff = '';
  if (surplus === null) aff = '';
  else if (surplus <= 0) aff = pickFor(id, 'a3', ['Declared expenses already exceed income, so there is no capacity for a new repayment on the customer\'s own figures.', 'On the declared figures there is no surplus to service a repayment.']);
  else if (retained) aff = pickFor(id, 'a1', [`On the declared figures the customer has a surplus of ${$(surplus)} a month against observed income of ${$(inc)}, and the statement shows a buffer being kept through the cycle.`, `Observed income of ${$(inc)} a month supports the declared surplus of ${$(surplus)}, and the balance is maintained between pays.`]);
  else aff = pickFor(id, 'a2', [`The declared surplus of ${$(surplus)} is not borne out by the statement, where the balance is consumed each cycle.`, `Although a surplus of ${$(surplus)} is declared, the statement does not show that money being retained.`]);
  if (aff) parts.push(aff);
  // 2b) behaviour tier driving the outcome
  if (r.expense_risk_tier === 'Lower' && /review|escalate|decline/i.test(r.behaviour_tier)) parts.push(pickFor(id, 'bt', ['The statement itself is acceptable; the referral comes from the repayment history score, which sits at review level.', 'Nothing on the statement blocks approval; prior repayment behaviour is what puts this at review level.']));
  // 3) behaviour history
  const b = goldBehaviour(other);
  if (b.includes('paid_previous_loan_early')) parts.push(pickFor(id, 'h1', ['The previous TerePay loan was repaid early and on time, which supports the customer\'s reliability.', 'A prior loan repaid ahead of schedule counts in the customer\'s favour.']));
  else if (b.includes('existing_defaults')) parts.push(pickFor(id, 'h2', ['The prior TerePay loan ended in arrears and a listed default with no response to contact, which weighs heavily against approval.', 'Previous repayment history includes a default and avoided contact.']));
  else if (b.includes('missed_payments_before')) parts.push('One earlier missed payment was caught up promptly after the customer made contact, which is a minor concern only.');
  // 4) conclusion consistent with the outcome
  const concl = r.recommendation === 'Deny' ? pickFor(id, 'c1', ['On this evidence the repayment would cause substantial hardship; decline and document the reasons.', 'A further loan would deepen existing hardship; the application should be declined.', 'The evidence does not support an affordable loan; decline.'])
    : r.recommendation === 'Conditional' ? (has(/medical|Medical/i) && !has(/overdraft|dishonour|Zero balance|BNPL|gambling|Remittances >/i) ? pickFor(id, 'c2m', ['Affordable on the statement; refer to a credit officer only to confirm income continuity and the remaining treatment cost before approval.', 'The statement supports the loan; the referral is to confirm the medical episode is covered and income is unaffected.']) : pickFor(id, 'c2', ['Refer to a credit officer: approval should depend on verifying income and, if approved, a reduced amount.', 'Not clear-cut; a credit officer should verify the concerns above and consider a smaller amount or a later repayment start.', 'Refer for manual review with the specific checks noted above before any approval.']))
    : pickFor(id, 'c3', ['The repayment is affordable without hardship; approve under standard processing.', 'No indication of hardship; standard approval is appropriate.', 'Approve; the loan is affordable on the evidence.']);
  parts.push(concl);
  // trim to ~80 words while keeping the conclusion
  let words = parts.join(' ').split(/\s+/);
  while (words.length > 85 && parts.length > 3) { parts.splice(parts.length - 2, 1); words = parts.join(' ').split(/\s+/); }
  return parts.join(' ');
}

const jsonl = []; const exam = []; let n = 0;
for (const c of cases) {
  const dir = path.join(root, c.id); const app = JSON.parse(fs.readFileSync(path.join(dir, 'application.json'), 'utf8')); const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  const text = fs.readFileSync(path.join(dir, 'statement-anz.txt'), 'utf8'); const p = parseTransactions(text);
  if (p.transactions.length < 10) continue;
  const A = analyseTransactions(p.transactions); const other = p.residual_text && p.residual_text.length > 120 ? p.residual_text : '';
  const findings = scoreAssessment(mergeObservations(A, {}, { hasOtherDocs: !!other, otherDocsText: other }), app, { documentCount: 1, parserMode: 'deterministic' });
  const brief = buildLlmBrief(A, app, other, findings);
  const user = 'VERIFIED METRICS AND STATEMENT LINES\n' + brief + '\n\nMake the judgement calls and write the narrative. Return ONLY the minified JSON object.';
  const judgements = goldJudgements(A, app, truth, other); const behaviour = goldBehaviour(other);
  const final = scoreAssessment(mergeObservations(A, { judgements, behaviour }, { hasOtherDocs: !!other, otherDocsText: other }), app, { documentCount: 1, parserMode: 'deterministic' });
  const note = goldNote(c.id, A, app, final, truth, other);
  const confidence = Math.max(40, Math.min(95, 90 - (A.unclassified.length >= 5 ? 10 : 0) - (A.period.days < 75 ? 10 : 0) - (other ? 0 : 5)));
  const data_gaps = []; if (!other) data_gaps.push('No credit history or prior-loan record provided'); if (A.period.days < 75) data_gaps.push('Fewer than 90 days of statements'); if (/medical/i.test(app.loan_purpose || '')) data_gaps.push('Confirmation of current employment/ACC status and remaining treatment cost');
  const gold = { judgements, behaviour, analyst_note: note, confidence, data_gaps };
  jsonl.push(JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }, { role: 'assistant', content: JSON.stringify(gold) }] }));
  exam.push({ id: c.id, profile: c.profile, user, gold, decision: `${final.risk_rating}/${final.recommendation}/${final.expense_risk_tier}`, triggered: [].concat(final.rule_hits.immediate_decline, final.rule_hits.critical, final.rule_hits.high, final.rule_hits.moderate).map(h => h.rule) });
  n++;
}
// split 85/15 train/exam by hash so it is stable
const train = [], test = [];
exam.forEach((e, i) => (hash(e.id) % 100 < 85 ? train : test).push(i));
fs.writeFileSync(path.join(out, 'train.jsonl'), train.map(i => jsonl[i]).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'exam.json'), JSON.stringify(test.map(i => exam[i]), null, 1));
fs.writeFileSync(path.join(out, 'gold-all.json'), JSON.stringify(exam, null, 1));
const words = exam.map(e => e.gold.analyst_note.split(/\s+/).length); const avg = (words.reduce((a, b) => a + b, 0) / words.length).toFixed(0);
console.log(`gold built for ${n} cases -> ${train.length} training examples (train.jsonl), ${test.length} exam cases (exam.json); note length avg ${avg} words (min ${Math.min(...words)}, max ${Math.max(...words)})`);
console.log('sample gold (first exam case):'); const e = exam[test[0]]; console.log(' ', e.id, e.decision); console.log('  judgements', JSON.stringify(e.gold.judgements), 'behaviour', JSON.stringify(e.gold.behaviour)); console.log('  note:', e.gold.analyst_note);
