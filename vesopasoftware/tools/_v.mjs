import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--enable-unsafe-swiftshader','--use-gl=angle'] });
const p = await b.newPage({ viewport:{width:1440,height:900} });
await p.goto('http://localhost:5090/?probe=1');
await p.waitForFunction(() => window.__vesopaReady, null, { timeout:30000 });
// the real resting position: the very bottom of the page
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(1800);
await p.screenshot({ path:'shots-new/v-mark.png' });
console.log('  shot at page bottom');
await b.close();
