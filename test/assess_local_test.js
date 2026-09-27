// Run one website-style AI assessment job without Redis or Google Drive: the sample statement stands in for the Drive
// documents. Exercises console/assess.js exactly as worker.js does (validation, folder guard, parse, LLM, scoring).
//   node test/assess_local_test.js [flagged|clean] [--missing]     (--missing: prove an incomplete payload is refused)
//   node test/assess_local_test.js flagged --model=terepay-analyst  (send payload.model, as the site does)
const fs = require('fs'), path = require('path');
const ASSESS = require('../console/assess.js');
const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'flagged';
const src = path.join(__dirname, `sample-statement-${which}.txt`);
const FOLDER = 'application/vnd.google-apps.folder';
const files = { 'folder-1': { id: 'folder-1', name: 'app_test', mimeType: FOLDER, parents: ['root-1'] }, 'doc-1': { id: 'doc-1', name: `statement-${which}.txt`, mimeType: 'text/plain', size: fs.statSync(src).size, parents: ['folder-1'] } };
const payload = {
  version: 1,
  application: { id: 'test-app-local', reference: 'TP-TEST-0001', applicant_name: 'Test Applicant A', loan_amount: 1500, interest_rate: 49, income: 4000, expenses: 3100, existing_debt: 1800, loan_purpose: 'car repairs', application_date: '2026-09-01T09:14:00+12:00', household_type: 'single', loan_history_count: 1, behaviour_paid_on_time_consistently: true },
  affordability: { assessed_amount: 1500, requested_amount: 1500, fortnightly_income: 1846.15, fortnightly_expenses: 1430.77, fortnightly_loan_payment: 411.5, fortnightly_surplus: 3.88, household_multiplier: 1, first_transaction_date: '2026-06-01', days_of_transaction_data: 100 },
  documents: [{ driveId: 'doc-1', name: `statement-${which}.txt`, kind: 'statement', type: 'bank_statement' }],
  folderId: 'folder-1', rootFolderId: 'root-1',
};
const modelArg = process.argv.find(a => a.startsWith('--model=')); if (modelArg) payload.model = modelArg.slice('--model='.length);
if (process.argv.includes('--missing')) { delete payload.application.income; payload.documents = []; }
const ctx = {
  jobId: 'local-' + Date.now(), log: m => console.log(new Date().toISOString().slice(11, 19), m),
  driveMeta: async id => { if (!files[id]) throw new Error('no such file ' + id); return files[id]; },
  downloadFile: async (id, dest) => { fs.copyFileSync(src, dest); return dest; },
  isCancelled: async () => false,
};
process.env.GOOGLE_DRIVE_KYC_FOLDER_ID = process.env.GOOGLE_DRIVE_KYC_FOLDER_ID || 'root-1';
ASSESS.runAssessment(payload, ctx).then(r => {
  console.log('\nRESULT', JSON.stringify({ model: r.model, risk: r.risk_rating, rec: r.recommendation, tier: r.expense_risk_tier, behaviour: r.behaviour_score, confidence: r.confidence_score, escalation: r.escalation, parser: r.parser_mode, docs: r.documents, llm: r.llm, ms: r.processing_ms }, null, 2));
  console.log('\nANALYST NOTE:', r.analyst_note); console.log('\nFACTORS:', r.factors.length, '| EVIDENCE:', r.evidence.length, '| audit:', r.audit_dir);
}).catch(e => { console.error('FAILED:', e.message, e.missing ? JSON.stringify(e.missing) : ''); process.exit(1); });
