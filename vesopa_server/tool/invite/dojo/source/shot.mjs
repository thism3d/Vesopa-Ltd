import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:600,height:300},deviceScaleFactor:2});
await p.goto('file://'+process.cwd()+'/'+process.argv[2]); await p.waitForTimeout(400);
await p.screenshot({path:process.argv[3], type: process.argv[3].endsWith('jpg')?'jpeg':'png', quality: process.argv[3].endsWith('jpg')?88:undefined, fullPage:true}); await b.close();
