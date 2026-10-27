// usage: node drive.js <buildDir> preview <outDir> f1 f2 ...   |   node drive.js <buildDir> video <out.mp4> <audio.wav>
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
(async () => {
  const [dir, mode, out, ...rest] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  p.on('console', m => console.log('page:', m.text())); p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(dir, 'render.html'));
  await p.evaluate(() => window.ready);
  const frame = async f => Buffer.from((await p.evaluate(f => window.renderFrame(f), f)).split(',')[1], 'base64');
  if (mode === 'preview') {
    fs.mkdirSync(out, { recursive: true });
    for (const f of rest) fs.writeFileSync(path.join(out, `p${String(f).padStart(4, '0')}.jpg`), await frame(+f));
  } else {
    const N = 900;
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '30', '-i', '-', '-i', rest[0],
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', '30',
      '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let f = 0; f < N; f++) {
      const buf = await frame(f);
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % 60 === 0) console.log(`frame ${f}/${N} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', r));
  }
  await b.close();
})();
