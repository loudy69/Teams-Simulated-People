// Converts clips/raw/*.mp4 into looping-friendly MJPEG files Chromium can use as a fake camera.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findFfmpeg() {
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg';
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(pk)) {
    for (const d of fs.readdirSync(pk).filter(d => d.startsWith('Gyan.FFmpeg'))) {
      const stack = [path.join(pk, d)];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(p); else if (e.name === 'ffmpeg.exe') return p;
        }
      }
    }
  }
  console.error('ffmpeg not found. Install: winget install Gyan.FFmpeg'); process.exit(1);
}

// Boomerang (forward then reversed) so the fake-camera loop has no visible jump.
const ffmpeg = findFfmpeg();
const raw = path.join(__dirname, '..', 'clips', 'raw');
const out = path.join(__dirname, '..', 'clips');
const wm = path.join(out, 'watermark.png');
if (!fs.existsSync(wm)) spawnSync('node', [path.join(__dirname, 'make-watermark.js')], { stdio: 'inherit' });
const filter = '[0:v]scale=640:360:force_original_aspect_ratio=increase,crop=640:360,fps=15,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v];[v][1:v]overlay=0:0';
for (const f of fs.readdirSync(raw).filter(f => f.endsWith('.mp4'))) {
  const dst = path.join(out, f.replace('.mp4', '.mjpeg'));
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-t', '12', '-i', path.join(raw, f), '-i', wm, '-an', '-filter_complex', filter, '-q:v', '5', dst], { stdio: 'inherit' });
  console.log(r.status === 0 ? `${f} -> ${path.basename(dst)}` : `${f} FAILED`);
}
