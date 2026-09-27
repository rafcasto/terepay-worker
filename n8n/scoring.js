// TerePay deterministic scoring engine — v1.0
// Applies the Expense Red Flags checklist, the Client Behaviour thresholds and the
// Borrower Behaviour Scorecard to the LLM's structured observations.
// The LLM counts and quotes; this function decides. Pure function, no I/O.
// Used verbatim inside the n8n "Parse & Score" Code node and by test/score.js.

function scoreAssessment(llm, app, meta) {
  meta = meta || {};
  llm = llm || {};
  app = app || {};
  const num = v => { if (v === null || v === undefined || v === '') return null; const x = Number(v); return isFinite(x) ? x : null; };
  const yes = v => v === true;

  const s  = llm.statement_summary  || {};
  const bn = llm.bnpl               || {};
  const cf = llm.cash_flow          || {};
  const cd = llm.credit_dependency  || {};
  const ga = llm.gambling           || {};
  const su = llm.substance          || {};
  const im = llm.impulse            || {};
  const fp = llm.financial_planning || {};
  const fs = llm.family_strain      || {};
  const re = llm.remittances        || {};
  const li = llm.lifestyle          || {};
  const bs = llm.behaviour_scorecard|| {};

  const hits = { immediate_decline: [], critical: [], high: [], moderate: [] };
  const hit = (tier, rule, value) => hits[tier].push({ rule, value });
  const gt = (v, t) => num(v) !== null && num(v) > t;
  const gte = (v, t) => num(v) !== null && num(v) >= t;

  // ---- Immediate decline triggers (Client Behaviour doc) ----
  if (yes(ga.any_activity))                          hit('immediate_decline', 'Any gambling activity', ga.operators && ga.operators.length ? ga.operators : true);
  if (gt(bn.max_per_week, 3))                        hit('immediate_decline', 'Daily BNPL usage (> 3 per week)', num(bn.max_per_week));
  if (gt(cf.zero_balance_events_per_month, 1))       hit('immediate_decline', 'Zero balance more than once per month', num(cf.zero_balance_events_per_month));
  if (cd.family_bailout_frequency === 'weekly')      hit('immediate_decline', 'Weekly family bailouts', 'weekly');

  // ---- Critical ----
  if (gt(bn.pct_of_income, 30))                      hit('critical', 'BNPL > 30% of income', num(bn.pct_of_income));
  if (gt(cf.days_under_50_per_month, 15))            hit('critical', 'Balance under $50 for > 15 days/month', num(cf.days_under_50_per_month));
  if (gt(cf.days_under_20_per_month, 7))             hit('critical', 'Balance under $20 for > 7 days/month', num(cf.days_under_20_per_month));
  if (yes(ga.any_activity))                          hit('critical', 'Gambling activity present', true);
  if (yes(cd.credit_paying_credit))                  hit('critical', 'Using credit to pay other credit', true);
  if (gt(bn.max_per_week, 3))                        hit('critical', 'Daily BNPL transactions', num(bn.max_per_week));
  if (yes(su.daily_alcohol))                         hit('critical', 'Daily alcohol purchases', true);
  if (yes(re.sent_while_bnpl_for_basics))            hit('critical', 'Remittances sent while using BNPL for basics', true);

  // ---- High ----
  if (gt(bn.monthly_spend, 300))                     hit('high', 'BNPL > $300/month', num(bn.monthly_spend));
  if (gt(cf.days_under_100_per_month, 15))           hit('high', 'Balance under $100 for > 15 days/month', num(cf.days_under_100_per_month));
  if (gte(cd.active_credit_facilities, 3))           hit('high', '3+ active credit facilities', num(cd.active_credit_facilities));
  if (gt(su.pct_of_income, 10))                      hit('high', 'Substance-related spend > 10% of income', num(su.pct_of_income));
  if (yes(su.tobacco_high_frequency))                hit('high', 'High-frequency tobacco purchases', true);
  if (fp.buffer_200_maintained === false)            hit('high', 'No $200 savings buffer maintained in 3 months', false);
  if (cd.family_bailout_frequency === 'monthly' || cd.family_bailout_frequency === 'weekly')
                                                     hit('high', 'Frequent family bailouts', cd.family_bailout_frequency);
  if (gt(re.pct_of_income, 25))                      hit('high', 'Remittances > 25% of income', num(re.pct_of_income));
  if (yes(re.sent_while_under_100))                  hit('high', 'Remittances sent while balance under $100', true);
  if (yes(re.undisclosed_obligation))                hit('high', 'Undisclosed remittance obligation', true);
  if (yes(li.luxury_while_bnpl_basics))              hit('high', 'Luxury purchases while using BNPL for basics', true);
  if (gte(cf.overdraft_or_dishonour_fees, 2))        hit('high', 'Multiple overdraft / dishonour fees', num(cf.overdraft_or_dishonour_fees));
  if (Array.isArray(cd.payday_lenders) && cd.payday_lenders.length >= 2)
                                                     hit('high', 'Multiple payday lenders', cd.payday_lenders);
  if (yes(ga.withdraw_redeposit_pattern))            hit('high', 'Large withdrawals followed by immediate re-deposits', true);
  if (yes(im.luxury_on_low_income))                  hit('high', 'Luxury-brand spending inconsistent with income', true);

  // ---- Moderate ----
  if (gt(bn.monthly_spend, 200) && !gt(bn.monthly_spend, 300)) hit('moderate', 'BNPL > $200/month', num(bn.monthly_spend));
  if (gt(cf.days_under_100_per_month, 7) && !gt(cf.days_under_100_per_month, 15)) hit('moderate', 'Balance under $100 for > 7 days/month', num(cf.days_under_100_per_month));
  if (yes(fp.chaotic_spending))                      hit('moderate', 'Chaotic spending pattern', true);
  if (fp.bill_payments_regular === false)            hit('moderate', 'Irregular bill payments', false);
  if (gt(li.dining_pct, 20))                         hit('moderate', 'Dining out > 20% of income', num(li.dining_pct));
  if (gt(li.entertainment_pct, 15))                  hit('moderate', 'Entertainment > 15% of income', num(li.entertainment_pct));
  if (yes(re.crisis_driven))                         hit('moderate', 'Crisis-driven large transfers', true);
  if (yes(fs.undisclosed_dependents_suspected))      hit('moderate', 'Undisclosed family obligations suspected', true);
  if (yes(im.same_day_multi_retail) || yes(im.daily_online_shopping) || yes(im.buy_return_cycles))
                                                     hit('moderate', 'Impulse shopping pattern', true);
  if (yes(cd.asset_sale_deposits))                   hit('moderate', 'Irregular deposits suggesting asset liquidation', true);
  if (gte(fp.bank_fee_count, 3))                     hit('moderate', 'Fee accumulation', num(fp.bank_fee_count));
  if (gte(li.subscriptions_count, 5))                hit('moderate', 'Subscription accumulation', num(li.subscriptions_count));

  // ---- Unplanned-expense shock (TerePay portfolio observation: medical-purpose loans default more often).
  // Framed as affordability / income-continuity checks, never as a purpose-based decline.
  const sh = llm.shock || {};
  const purpose = String(app.loan_purpose || '').toLowerCase();
  const medicalPurpose = /medical|hospital|surgery|surgical|dental|dentist|doctor|health|pharmac|treatment|operation|specialist|ivf|maternity|funeral|tangi/.test(purpose);
  if (medicalPurpose)                                hit('moderate', 'Loan purpose is medical / unplanned expense - verify income continuity and total cost of the episode', app.loan_purpose);
  if (gt(sh.income_drop_pct, 25))                    hit('high', 'Income fell > 25% in the most recent 30 days', num(sh.income_drop_pct));
  else if (gt(sh.income_drop_pct, 10))               hit('moderate', 'Income fell > 10% in the most recent 30 days', num(sh.income_drop_pct));
  if (gt(sh.medical_pct_of_income, 10))              hit('moderate', 'Medical costs > 10% of income', num(sh.medical_pct_of_income));
  if (medicalPurpose && (gt(sh.income_drop_pct, 10) || gt(sh.medical_pct_of_income, 10) || gte(sh.acc_or_claim_credits, 1)))
                                                     hit('high', 'Medical purpose with evidence of reduced income or ongoing medical costs', { income_drop_pct: num(sh.income_drop_pct), medical_pct: num(sh.medical_pct_of_income) });

  const c = hits.critical.length, h = hits.high.length, m = hits.moderate.length;
  let expenseTier;
  if (hits.immediate_decline.length || c >= 3) expenseTier = 'Critical';
  else if (c === 2 || h >= 4)                   expenseTier = 'High';
  else if (c === 1 || h >= 2)                   expenseTier = 'Moderate';
  else if (h === 1 || m >= 3)                   expenseTier = 'Moderate'; // cumulative-effect rule (Implementation Notes #3)
  else                                          expenseTier = 'Lower';
  if (medicalPurpose && expenseTier === 'Lower') expenseTier = 'Moderate';   // TerePay observation: medical-purpose loans default more -> always a credit-officer look, never auto-approve

  // ---- Borrower Behaviour Scorecard ----
  const WEIGHTS = {
    paid_previous_loan_early: 3, paid_on_time_consistently: 2, communicates_proactively: 2,
    missed_payments_before: -2, existing_defaults: -3, write_off_history: -5,
    requests_bigger_loan_too_fast: -2, provides_multiple_excuses: -2, avoids_communication: -4
  };
  let behaviourScore = 0, behaviourEvidence = false; const ticks = [];
  for (const k of Object.keys(WEIGHTS)) if (bs[k] === true) { behaviourScore += WEIGHTS[k]; ticks.push({ item: k, score: WEIGHTS[k] }); behaviourEvidence = true; }
  let behaviourTier;
  if (!behaviourEvidence)        behaviourTier = 'No behaviour history evidenced';
  else if (behaviourScore >= 5)  behaviourTier = 'Low risk — approve';
  else if (behaviourScore >= 2)  behaviourTier = 'Low–medium risk';
  else if (behaviourScore >= 0)  behaviourTier = 'Medium risk — review';
  else if (behaviourScore >= -3) behaviourTier = 'High risk — escalate';
  else                           behaviourTier = 'Severe risk — decline';

  // ---- Affordability sanity checks from the application record ----
  const income = num(app.income), expenses = num(app.expenses), debt = num(app.existing_debt), loan = num(app.loan_amount);
  const declaredSurplus = (income !== null && expenses !== null) ? +(income - expenses).toFixed(2) : null;
  const observedIncome = num(s.observed_net_monthly_income);
  const incomeMismatchPct = (income && observedIncome !== null) ? +Math.abs((observedIncome - income) / income * 100).toFixed(1) : null;
  const engineFactors = [];
  let affordabilityHold = false;
  if (declaredSurplus !== null) {
    engineFactors.push({ name: 'Declared monthly surplus', assessment: `Income $${income} − expenses $${expenses} = $${declaredSurplus}${debt !== null ? ` (existing debt $${debt})` : ''}${loan !== null ? `, requested $${loan}` : ''}`, impact: declaredSurplus > 0 ? 'Positive' : 'Negative' });
    if (declaredSurplus <= 0) affordabilityHold = true;
  }
  if (incomeMismatchPct !== null && incomeMismatchPct > 20) {
    affordabilityHold = true;
    engineFactors.push({ name: 'Income verification mismatch', assessment: `Declared $${income}/month vs observed $${observedIncome}/month in statements (${incomeMismatchPct}% difference). Verify before relying on declared figures.`, impact: 'Negative' });
  }
  // ---- Payslip reconciliation (payslips parsed by code; see summarisePayslips) ----
  const psCount = num(s.payslip_count) || 0, psNet = num(s.payslip_net_monthly), psVsStmt = num(s.payslip_vs_statement_pct), psVsDecl = num(s.payslip_vs_declared_pct), psMatched = num(s.payslip_matched) || 0;
  let payslipStatus = psCount ? 'unreadable' : 'none';
  if (psCount && psNet !== null) {
    if (psVsStmt !== null && psVsStmt > 20) {
      payslipStatus = 'mismatch'; affordabilityHold = true;
      engineFactors.push({ name: 'Payslip does not reconcile with statement', assessment: `Payslip net $${psNet}/month vs $${observedIncome}/month credited in statements (${psVsStmt}% difference). Pay may go to another account, hours may have changed, or the document is not genuine — verify before relying on either figure.`, impact: 'Negative' });
    } else if (psVsDecl !== null && psVsDecl > 20 && income > psNet) {
      payslipStatus = 'declared_overstated'; affordabilityHold = true;
      engineFactors.push({ name: 'Declared income exceeds payslip', assessment: `Declared $${income}/month vs payslip net $${psNet}/month (${psVsDecl}% difference). Use payslip income for affordability.`, impact: 'Negative' });
    } else {
      payslipStatus = 'verified';
      engineFactors.push({ name: 'Income verified by payslip', assessment: `${psCount} payslip(s)${s.payslip_employer ? ` from ${s.payslip_employer}` : ''}: net $${psNet}/month${psVsStmt !== null ? `, within ${psVsStmt}% of statement credits` : ''}${psMatched ? `, ${psMatched} pay credit(s) matched by date and amount` : ''}.`, impact: 'Positive' });
    }
  } else if (psCount) {
    engineFactors.push({ name: 'Payslip unreadable', assessment: `${psCount} payslip document(s) supplied but no pay amounts could be read. Credit officer to check manually.`, impact: 'Neutral' });
  }

  const docCount = meta.documentCount;
  // ---- Decision (worst of expense tier and behaviour tier) ----
  let risk, rec, escalation, pathway;
  const sevB = behaviourTier.startsWith('Severe'), highB = behaviourTier.startsWith('High'), medB = behaviourTier.startsWith('Medium');
  if (expenseTier === 'Critical' || sevB) {
    risk = 'High'; rec = 'Deny'; escalation = 'decline';
    pathway = 'Decline recommended. Document rationale per CCCFA s.9CA. Do not approve.';
  } else if (expenseTier === 'High' || highB) {
    risk = 'High'; rec = 'Conditional'; escalation = 'senior_credit_officer';
    pathway = 'Manual escalation to senior credit officer. Likely decline unless clearly explained. Apply maximum loan amount restriction and enhanced monitoring.';
  } else if (expenseTier === 'Moderate' || medB) {
    risk = 'Medium'; rec = 'Conditional'; escalation = 'credit_officer';
    pathway = 'Enhanced manual review by credit officer. Standard underwriting with noted concerns; consider reducing approved amount; may require additional documentation.';
  } else {
    risk = 'Low'; rec = 'Approve'; escalation = 'none';
    pathway = behaviourTier === 'Low–medium risk' ? 'Standard processing with continued monitoring of repayment behaviour.' : 'Standard processing. AI-assisted assessment. No escalation required.';
  }
  if (meta.parserMode === 'fallback' || meta.parserMode === 'none' || docCount === 0) {
    engineFactors.push({ name: meta.parserMode === 'none' || docCount === 0 ? 'No bank statements available' : 'Unverified counts', assessment: meta.parserMode === 'none' || docCount === 0 ? 'No supporting documents were parsed; expense screening could not be performed. Obtain statements before any approval.' : 'Statement could not be parsed deterministically; figures were estimated by the language model and must be verified by a credit officer.', impact: 'Negative' });
    if (rec === 'Approve') { risk = 'Medium'; rec = 'Conditional'; escalation = 'credit_officer'; pathway = 'Automatic approval blocked: statement metrics are model-estimated, not parsed. Credit officer to verify.'; }
  }
  if (rec === 'Approve' && affordabilityHold) {
    risk = 'Medium'; rec = 'Conditional'; escalation = 'credit_officer';
    pathway = 'Affordability check failed on declared/observed figures. Credit officer to verify income and expenses before approval.';
  }

  // ---- Confidence = quality of evidence, not model bravado ----
  let confidence = num(llm.confidence); if (confidence === null) confidence = 50;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  if (docCount === 0) confidence = Math.min(confidence, 25);
  if (meta.parserMode === 'fallback' || meta.parserMode === 'none') confidence = Math.min(confidence, 40);
  if (num(s.period_days) !== null && num(s.period_days) < 60) confidence = Math.min(confidence, 60);
  if (Array.isArray(llm.data_gaps) && llm.data_gaps.length >= 3) confidence = Math.min(confidence, 50);

  const prelim = typeof llm.preliminary_risk_view === 'string' ? llm.preliminary_risk_view : null;
  if (prelim && prelim !== expenseTier) engineFactors.push({ name: 'Model view vs rules engine', assessment: `Analyst model suggested ${prelim}; rules engine determined ${expenseTier} from the counted thresholds. Rules engine governs.`, impact: 'Neutral' });

  const summarise = arr => arr.map(x => `${x.rule}${x.value !== true && x.value !== undefined ? ` (${Array.isArray(x.value) ? x.value.join(', ') : x.value})` : ''}`);
  for (const [tier, label] of [['immediate_decline', 'Immediate-decline trigger'], ['critical', 'Critical red flag'], ['high', 'High-risk indicator'], ['moderate', 'Moderate-risk flag']]) {
    for (const x of hits[tier]) engineFactors.push({ name: `${label}: ${x.rule}`, assessment: x.value === true || x.value === undefined ? 'Threshold met.' : `Observed value: ${Array.isArray(x.value) ? x.value.join(', ') : x.value}`, impact: 'Negative' });
  }
  if (ticks.length) engineFactors.push({ name: 'Borrower behaviour score', assessment: `${behaviourScore >= 0 ? '+' : ''}${behaviourScore} (${behaviourTier}): ${ticks.map(t => `${t.item.replace(/_/g, ' ')} ${t.score > 0 ? '+' : ''}${t.score}`).join('; ')}`, impact: behaviourScore >= 2 ? 'Positive' : behaviourScore < 0 ? 'Negative' : 'Neutral' });

  const VALID_IMPACT = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral' };
  const llmFactors = (Array.isArray(llm.factors) ? llm.factors : []).filter(f => f && f.name).map(f => ({ name: String(f.name), assessment: String(f.assessment || ''), impact: VALID_IMPACT[String(f.impact || 'neutral').toLowerCase()] || 'Neutral' }));

  const header = [
    `RULES ENGINE OUTCOME — expense tier ${expenseTier} (${hits.immediate_decline.length} immediate-decline, ${c} critical, ${h} high, ${m} moderate flags); behaviour score ${behaviourScore >= 0 ? '+' : ''}${behaviourScore} (${behaviourTier}).`,
    `DECISION — risk ${risk}, recommendation ${rec}. Pathway: ${pathway}`,
    hits.immediate_decline.length ? `IMMEDIATE-DECLINE TRIGGERS — ${summarise(hits.immediate_decline).join('; ')}` : null,
    c ? `CRITICAL — ${summarise(hits.critical).join('; ')}` : null,
    h ? `HIGH — ${summarise(hits.high).join('; ')}` : null,
    m ? `MODERATE — ${summarise(hits.moderate).join('; ')}` : null,
    docCount === 0 ? 'NOTE — no supporting documents were available; expense screening could not be performed.' : null
  ].filter(Boolean).join('\n');

  return {
    risk_rating: risk,
    recommendation: rec,
    confidence_score: confidence,
    factors: engineFactors.concat(llmFactors),
    reasoning: header + '\n\nANALYST NOTE\n' + String(llm.reasoning || '(none provided)'),
    evidence: (Array.isArray(llm.evidence) ? llm.evidence : []).map(String),
    expense_risk_tier: expenseTier,
    behaviour_score: behaviourScore,
    behaviour_tier: behaviourTier,
    escalation,
    pathway,
    rule_hits: hits,
    affordability: { declared_surplus: declaredSurplus, observed_income: observedIncome, income_mismatch_pct: incomeMismatchPct, payslip_income: psNet, payslip_status: payslipStatus, hold: affordabilityHold },
    llm_preliminary_view: prelim,
    data_gaps: Array.isArray(llm.data_gaps) ? llm.data_gaps : []
  };
}

if (typeof module !== 'undefined') module.exports = { scoreAssessment };
