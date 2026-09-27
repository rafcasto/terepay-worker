// node score.js <llm.json> <application.json> [documentCount]
const fs = require('fs');
const { scoreAssessment } = require('../n8n/scoring.js');
const llm = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const app = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const r = scoreAssessment(llm, app, { documentCount: Number(process.argv[4] || 1) });
console.log(JSON.stringify(r, null, 2));
