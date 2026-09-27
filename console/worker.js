#!/usr/bin/env node
// TerePay Worker — runs on the Pi, driven by the TerePay site (Vercel): model training jobs from the admin console
// and AI credit assessments from the lender's affordability wizard (Results & Decision step).
//
//   site  --LPUSH-->  training:queue    --RPOP-->  this worker  --HSET-->  training:job:<id>    <--HGETALL--  site
//   site  --LPUSH-->  assessment:queue  --RPOP-->  this worker  --HSET-->  assessment:job:<id>  <--HGETALL--  site
//   (assessment jobs are drained first: a lender is waiting on them; see assess.js)
//
// The Pi never accepts inbound connections: it polls Upstash Redis over HTTPS (REST) and pulls training data
// from the Google Drive training folder with the same service account the website uses. Nothing about the
// decision logic changes — every job calls the same functions the LAN console (server.js) uses.
//
//   node console/worker.js            (reads ../.env if present; systemd unit: deploy/terepay-worker.service)
//
// Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL,
//      GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_DRIVE_TRAINING_FOLDER_ID (optional guard),
//      TRAINING_POLL_MS (default 5000), TRAINING_WORKER_ID (default hostname)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');

// ---- tiny .env loader (systemd injects the file; this covers `node console/worker.js` by hand) ----
(function loadEnv() {
  const f = path.join(ROOT, '.env'); if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line); if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

const { Redis } = require('@upstash/redis');
const { google } = require('googleapis');
const C = require('./server.js');
const RPC = require('./rpc.js');
const ASSESS = require('./assess.js');

const VERSION = '1.1.0';
const POLL_MS = Number(process.env.TRAINING_POLL_MS || 5000);
const WORKER_ID = process.env.TRAINING_WORKER_ID || os.hostname();
const TRAINING_FOLDER = process.env.GOOGLE_DRIVE_TRAINING_FOLDER_ID || '';
const K = { queue: 'training:queue', jobs: 'training:jobs', job: id => `training:job:${id}`, aqueue: 'assessment:queue', ajob: id => `assessment:job:${id}`, worker: 'training:worker', state: 'training:state', rpc: 'training:rpc', rpcReply: id => `training:rpc:${id}` };
const LOG_TAIL = 12000;   // chars of log kept in Redis per job
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const say = (...a) => console.log(new Date().toISOString(), ...a);

for (const v of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(2); }
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

let driveClient = null;
function drive() {
  if (driveClient) return driveClient;
  const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL, key = (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google Drive service account is not configured (GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY)');
  driveClient = google.drive({ version: 'v3', auth: new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }) });
  return driveClient;
}

// ---------------- Google Drive: download a file, or a whole folder tree, into a temp dir ----------------
const FOLDER = 'application/vnd.google-apps.folder';
async function driveMeta(id) { const r = await drive().files.get({ fileId: id, fields: 'id,name,mimeType,size,parents', supportsAllDrives: true }); return r.data; }
async function downloadFile(id, dest) {
  const res = await drive().files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  await new Promise((resolve, reject) => { const w = fs.createWriteStream(dest); res.data.on('error', reject); w.on('error', reject); w.on('finish', resolve); res.data.pipe(w); });
  return dest;
}
async function listChildren(folderId) {
  const out = []; let pageToken;
  do {
    const r = await drive().files.list({ q: `'${folderId}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,size)', pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    out.push(...(r.data.files || [])); pageToken = r.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}
const safeName = n => String(n || 'file').replace(/[\/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 120);
async function downloadFolder(folderId, dest, log, depth) {
  depth = depth || 0; if (depth > 4) { log(`skipping folder deeper than 4 levels`); return 0; }
  fs.mkdirSync(dest, { recursive: true }); let n = 0;
  for (const f of await listChildren(folderId)) {
    if (f.mimeType === FOLDER) { n += await downloadFolder(f.id, path.join(dest, safeName(f.name)), log, depth + 1); continue; }
    if (f.mimeType && f.mimeType.startsWith('application/vnd.google-apps.')) { log(`skip (Google Doc, not a file): ${f.name}`); continue; }
    if (!/\.(pdf|txt|csv|json|zip)$/i.test(f.name)) { log(`skip (unsupported type): ${f.name}`); continue; }
    await downloadFile(f.id, path.join(dest, safeName(f.name))); n++;
  }
  return n;
}
// The website only enqueues entries that live in the training folder; if the worker knows that folder, double-check.
async function assertInTrainingFolder(meta) {
  if (!TRAINING_FOLDER) return;
  let cur = meta; for (let i = 0; i < 6; i++) { const parents = cur.parents || []; if (parents.includes(TRAINING_FOLDER)) return; if (!parents.length) break; cur = await driveMeta(parents[0]); }
  throw new Error(`Drive item ${meta.id} is not inside the training folder`);
}

// ---------------- job bookkeeping in Redis ----------------
async function patchJob(id, fields, keyOf) { await redis.hset((keyOf || K.job)(id), fields); }
function makeLogger(id, keyOf) {
  let buf = '', timer = null, flushing = Promise.resolve();
  const flush = () => { flushing = flushing.then(() => patchJob(id, { log: buf.slice(-LOG_TAIL) }, keyOf)).catch(e => say('log flush failed', e.message)); return flushing; };
  const log = msg => { const line = `${new Date().toISOString().slice(11, 19)} ${msg}`; buf += line + '\n'; say(`[${id}] ${msg}`); if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 1500); };
  log.done = async () => { if (timer) { clearTimeout(timer); timer = null; } await flush(); };
  log.text = () => buf;
  return log;
}
async function cancelled(id, keyOf) { const c = await redis.hget((keyOf || K.job)(id), 'cancel'); return c === 1 || c === '1' || c === true; }

// Follow a spawned console job (finetune / exam / regenerate): mirror its log file into Redis, honour cancel.
async function follow(j, jobId, log) {
  let last = 0; let done = false; j.done.then(() => { done = true; });
  while (!done) {
    await sleep(4000);
    try { const t = fs.readFileSync(j.log, 'utf8'); if (t.length > last) { for (const line of t.slice(last).split('\n')) if (line.trim()) log(line); last = t.length; } } catch (e) {}
    if (await cancelled(jobId)) { log('cancel requested — killing process'); try { process.kill(j.pid, 'SIGTERM'); } catch (e) {} await sleep(3000); try { process.kill(j.pid, 'SIGKILL'); } catch (e) {} }
  }
  const r = await j.done; if (r.status !== 'done') throw new Error(`${j.name} exited with code ${r.code}`);
  return { console_job: j.id, log_file: path.basename(j.log) };
}

function trimBacktest(b) {
  const lite = Object.assign({}, b); delete lite.rows;
  lite.triggers = (b.triggers || []).slice(0, 40); lite.would_approve_but_bad = (b.would_approve_but_bad || []).slice(0, 50); lite.would_deny_but_repaid = (b.would_deny_but_repaid || []).slice(0, 50);
  return lite;
}

// ---------------- the jobs ----------------
async function execute(job, log) {
  const p = job.payload || {};
  switch (job.type) {
    case 'import_batch':
    case 'import_outcomes': {
      const meta = await driveMeta(p.driveId); await assertInTrainingFolder(meta);
      const tmp = fs.mkdtempSync(path.join(C.DIRS.jobs, 'drive-'));
      try {
        if (meta.mimeType === FOLDER) {
          log(`downloading Drive folder "${meta.name}"…`); const n = await downloadFolder(meta.id, path.join(tmp, 'root', safeName(meta.name)), log); log(`downloaded ${n} files`);
          if (job.type === 'import_outcomes') throw new Error('import_outcomes needs a CSV file, not a folder');
          return C.importBatchDir(path.join(tmp, 'root'), { replace: p.replace !== false, log });
        }
        const dest = path.join(tmp, safeName(meta.name)); log(`downloading "${meta.name}" (${meta.size ? (meta.size / 1e6).toFixed(1) + ' MB' : 'size unknown'})…`); await downloadFile(meta.id, dest);
        if (/\.csv$/i.test(meta.name) || job.type === 'import_outcomes') { const r = C.importOutcomesCsv(dest); log(`outcomes: ${r.updated} updated, ${r.missing.length} without a case`); return r; }
        if (/\.zip$/i.test(meta.name)) { log('unpacking and analysing…'); const r = C.importBatchZip(dest, { replace: p.replace !== false, log }); log(`imported ${r.folders} folders: ${JSON.stringify(r.counts)}`); return r; }
        throw new Error(`Unsupported file type: ${meta.name} (use a .zip batch, a .csv of outcomes, or a folder)`);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    case 'backtest': { log('running rules engine backtest over all real cases…'); const b = C.computeBacktest(); log(`${b.with_outcome} funded loans with an outcome, base bad rate ${b.base_bad_rate}%`); return trimBacktest(b); }
    case 'build_dataset': { log('building train.jsonl…'); const s = C.buildDataset(); log(`${s.examples} examples (${s.synthetic} synthetic, ${s.real_labelled} real labelled ×3)`); return s; }
    case 'finetune': { const j = C.startFinetune(p.outName); log(`fine-tune started (${j.cmd})`); return follow(j, job.id, log); }
    case 'exam': { const j = C.startExam({ model: p.model, n: p.n, system: p.system }); log(`exam started: ${j.cmd}`); const r = await follow(j, job.id, log); return Object.assign(r, { latest: C.listExams().slice(-1)[0] || null }); }
    case 'assess_application': {
      // Website AI credit assessment: every input arrives in the payload; assess.js validates it, fetches the documents
      // by Drive id and runs parser -> rules engine -> LLM note -> rules engine. Result is stored on the job hash.
      const payload = typeof p === 'string' ? JSON.parse(p) : p;
      return ASSESS.runAssessment(payload, { log, jobId: job.id, driveMeta, downloadFile, isCancelled: () => cancelled(job.id, K.ajob) });
    }
    case 'regenerate_synthetic': { const j = C.startRegenerate({ n: p.n, seed: p.seed }); log(`regenerating synthetic cases: ${j.cmd}`); return follow(j, job.id, log); }
    default: throw new Error(`Unknown job type: ${job.type}`);
  }
}

// ---------------- state + heartbeat ----------------
async function publishState() {
  try {
    const s = C.settings(); let backtest = null;
    try { const b = C.computeBacktest(); if (b.total) backtest = { total: b.total, with_outcome: b.with_outcome, base_bad_rate: b.base_bad_rate, by_recommendation: b.by_recommendation }; } catch (e) {}
    const state = { dataset: C.datasetInfo(), models: await C.listModels(), exams: C.listExams().slice(-10).reverse(), backtest,
      settings: { gpu_mode: s.gpu_mode, base_model: s.base_model, ollama_name: s.ollama_name, epochs: s.epochs, ssh_host_set: !!s.ssh_host, local_gpu: fs.existsSync('/usr/bin/nvidia-smi') }, updatedAt: now() };
    await redis.set(K.state, JSON.stringify(state));
  } catch (e) { say('publishState failed', e.message); }
}
let current = null, currentKey = null; const startedAt = now();
async function heartbeat() {
  try { await redis.set(K.worker, JSON.stringify({ id: WORKER_ID, host: os.hostname(), pid: process.pid, version: VERSION, startedAt, at: now(), current, pollMs: POLL_MS, assessment: true, model: ASSESS.MODEL, drive: !!(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY) }), { ex: 120 }); }
  catch (e) { say('heartbeat failed', e.message); }
}

// ---------------- request/reply for the website (cases, labels, gold review, settings…) ----------------
// site: LPUSH training:rpc {id, op, args}  →  worker: SET training:rpc:<id> {ok, data|error} EX 60
let rpcBusy = false;
async function pumpRpc() {
  if (rpcBusy) return; rpcBusy = true;
  try {
    for (let i = 0; i < 20; i++) {
      const raw = await redis.rpop(K.rpc); if (!raw) break;
      let req = raw; if (typeof raw === 'string') { try { req = JSON.parse(raw); } catch (e) { continue; } }
      if (!req || !req.id || !req.op) continue;
      let reply; const t0 = now();
      try { reply = { ok: true, data: RPC.handle(req.op, req.args) }; }
      catch (e) { reply = { ok: false, error: String(e.message || e).slice(0, 500) }; if (!e.status) say(`rpc ${req.op} failed`, e.message); }
      await redis.set(K.rpcReply(req.id), JSON.stringify(reply), { ex: 60 });
      if (/\.(label|reanalyse|delete|review|set)$/.test(req.op)) { say(`rpc ${req.op} ${now() - t0} ms`); publishState().catch(() => {}); }
    }
  } catch (e) { say('rpc pump error', e.message); }
  finally { rpcBusy = false; }
}
setInterval(() => { pumpRpc(); }, 1000);

// ---------------- main loop ----------------
// keyOf: K.job (training) or K.ajob (assessment) — same hash layout, different namespace.
async function runOne(id, keyOf) {
  keyOf = keyOf || K.job;
  const job = await redis.hgetall(keyOf(id));
  if (!job) { say(`job ${id} has no record — dropped`); return; }
  if (job.status !== 'queued') { say(`job ${id} is ${job.status}, skipping`); return; }
  if (await cancelled(id, keyOf)) { await patchJob(id, { status: 'cancelled', endedAt: now() }, keyOf); return; }
  const log = makeLogger(id, keyOf); current = id; currentKey = keyOf;
  await patchJob(id, { status: 'running', startedAt: now(), worker: WORKER_ID, log: '' }, keyOf); await heartbeat();
  log(`${job.type} started on ${WORKER_ID}`);
  try {
    const result = await execute(job, log);
    const wasCancelled = await cancelled(id, keyOf);
    log(wasCancelled ? 'cancelled' : 'done'); await log.done();
    await patchJob(id, { status: wasCancelled ? 'cancelled' : 'done', endedAt: now(), result: result === undefined ? null : result, progress: '' }, keyOf);
  } catch (e) {
    log(`FAILED: ${e.message}`); await log.done();
    await patchJob(id, { status: (await cancelled(id, keyOf)) ? 'cancelled' : 'failed', endedAt: now(), error: String(e.message || e).slice(0, 2000), progress: '' }, keyOf);
  } finally { current = null; currentKey = null; if (keyOf === K.job) await publishState(); await heartbeat(); }
}
async function main() {
  say(`TerePay worker ${VERSION} (${WORKER_ID}) polling ${K.aqueue} + ${K.queue} every ${POLL_MS} ms; assessment model ${ASSESS.MODEL}`);
  await heartbeat(); await publishState(); let lastBeat = now(), lastState = now();
  for (;;) {
    try {
      if (now() - lastBeat > 30000) { await heartbeat(); lastBeat = now(); }
      if (now() - lastState > 300000) { await publishState(); lastState = now(); }
      const aid = await redis.rpop(K.aqueue);                         // lenders first
      if (aid) { await runOne(String(aid), K.ajob); continue; }
      const id = await redis.rpop(K.queue);
      if (id) { await runOne(String(id), K.job); continue; }
      await sleep(POLL_MS);
    } catch (e) { say('loop error', e.message); await sleep(Math.max(POLL_MS, 10000)); }
  }
}
process.on('SIGTERM', async () => { say('SIGTERM'); if (current) { try { await patchJob(current, { status: 'failed', error: 'worker stopped', endedAt: now() }, currentKey || K.job); } catch (e) {} } process.exit(0); });
main().catch(e => { console.error(e); process.exit(1); });
