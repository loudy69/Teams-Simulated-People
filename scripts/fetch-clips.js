// Downloads one free-to-use (Pexels licence) stock clip per persona into ./clips/raw
// Usage: set PEXELS_API_KEY (free at pexels.com/api) then: npm run fetch-clips
const fs = require('fs');
const path = require('path');
const personas = require('../personas.json');

const key = process.env.PEXELS_API_KEY;
if (!key) { console.error('Set PEXELS_API_KEY first.'); process.exit(1); }
const raw = path.join(__dirname, '..', 'clips', 'raw');
fs.mkdirSync(raw, { recursive: true });

(async () => {
  for (const p of personas) {
    const out = path.join(raw, `${p.id}.mp4`);
    if (fs.existsSync(out)) continue;
    const r = await fetch(`https://api.pexels.com/videos/search?per_page=10&size=medium&query=${encodeURIComponent(p.query)}`, { headers: { Authorization: key } });
    const data = await r.json();
    const vid = (data.videos || []).find(v => v.duration >= 8);
    const file = vid && vid.video_files.filter(f => f.file_type === 'video/mp4' && f.width <= 1280).sort((a, b) => b.width - a.width)[0];
    if (!file) { console.warn(`No clip for ${p.name}; adjust query in personas.json`); continue; }
    fs.writeFileSync(out, Buffer.from(await (await fetch(file.link)).arrayBuffer()));
    console.log(`${p.name}: ${vid.url}`);
  }
})();
