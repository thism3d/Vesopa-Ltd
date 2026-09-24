import 'dotenv/config';
import { StoreSubmissionClient } from './src/client.js';
import { resolveStoreId } from './src/apps.config.js';
const c = new StoreSubmissionClient({
  tenantId: process.env.MS_STORE_TENANT_ID,
  clientId: process.env.MS_STORE_CLIENT_ID,
  clientSecret: process.env.MS_STORE_CLIENT_SECRET,
});
const id = resolveStoreId('vesopa-loyalty');
const app = await c.getApplication(id);
const s = await c.getSubmission(id, app.pendingApplicationSubmission.id);
const l = s.listings?.['en-gb']?.baseListing ?? {};
console.log('description   :', (l.description||'').length, 'chars');
console.log('release notes :', (l.releaseNotes||'').length, 'chars');
console.log('short desc    :', (l.shortDescription||'').length, 'chars');
console.log('features      :', (l.features||[]).length, JSON.stringify(l.features||[]));
console.log('copyright     :', JSON.stringify(l.copyrightAndTrademarkInfo||''));
console.log('keywords      :', JSON.stringify(l.keywords||[]));
console.log('images        :', (l.images||[]).length);
console.log('publish mode  :', s.targetPublishMode);
console.log('cert notes    :', (s.notesForCertification||'').length, 'chars');
console.log('\noutstanding:');
for (const e of s.statusDetails?.errors ?? []) console.log('  -', e.details || e.code);
