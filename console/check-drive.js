#!/usr/bin/env node
// Verify the worker's Google Drive access to the training folder:  node console/check-drive.js [folderId]
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
(function loadEnv() { const f = path.join(ROOT, '.env'); if (!fs.existsSync(f)) return; for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (!m || process.env[m[1]] !== undefined) continue; let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); process.env[m[1]] = v; } })();
const { google } = require('googleapis');
const folderId = process.argv[2] || process.env.GOOGLE_DRIVE_TRAINING_FOLDER_ID;
const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL, key = (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
if (!email || !key) { console.error('✗ GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY not set in ' + path.join(ROOT, '.env')); process.exit(2); }
if (!folderId) { console.error('✗ no folder id (argument or GOOGLE_DRIVE_TRAINING_FOLDER_ID)'); process.exit(2); }
(async () => {
  const drive = google.drive({ version: 'v3', auth: new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }) });
  try { const me = await drive.about.get({ fields: 'user' }); console.log('✓ authenticated as', me.data.user.emailAddress); }
  catch (e) { console.error('✗ auth failed:', e.message); process.exit(1); }
  try {
    const f = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType,owners(emailAddress)', supportsAllDrives: true });
    if (f.data.mimeType !== 'application/vnd.google-apps.folder') { console.error(`✗ ${folderId} is not a folder (${f.data.mimeType})`); process.exit(1); }
    console.log(`✓ folder "${f.data.name}" (${folderId}) owner ${(f.data.owners || []).map(o => o.emailAddress).join(',') || '?'}`);
    const r = await drive.files.list({ q: `'${folderId}' in parents and trashed = false`, fields: 'files(name,mimeType,size,modifiedTime)', pageSize: 50, orderBy: 'folder,modifiedTime desc', supportsAllDrives: true, includeItemsFromAllDrives: true });
    const files = r.data.files || []; console.log(`✓ can list contents: ${files.length} item(s)`);
    for (const x of files) console.log(`   ${x.mimeType === 'application/vnd.google-apps.folder' ? '[dir] ' : '      '}${x.name}${x.size ? '  ' + (x.size / 1e6).toFixed(1) + ' MB' : ''}  ${x.modifiedTime || ''}`);
  } catch (e) { console.error(`✗ cannot access folder ${folderId}: ${e.message}`); console.error(`   → share the folder with ${email} (Viewer) and check the id`); process.exit(1); }
})();
