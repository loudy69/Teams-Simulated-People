// Imports manually downloaded clips from clips/inbox into clips/raw/pXX.mp4, then converts them.
// Mapping: a file whose name contains a persona id (p03) or first name (mei) is assigned to that persona;
// remaining files fill the unassigned personas in alphabetical order.
// Usage: npm run import-clips            (add --links to print search links for each persona)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const personas = require('../personas.json');

const root = path.join(__dirname, '..', 'clips');
const inbox = path.join(root, 'inbox');
const raw = path.join(root, 'raw');
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(raw, { recursive: true });

if (process.argv.includes('--links')) {
  for (const p of personas) {
    const q = encodeURIComponent(p.query);
    console.log(`${p.id} ${p.name}\n  https://pixabay.com/videos/search/${q}/\n  https://mixkit.co/free-stock-video/${encodeURIComponent(p.query.split(' ').slice(0, 2).join('-'))}/\n  https://coverr.co/s?q=${q}`);
  }
  console.log(`\nSave downloads into ${inbox}`);
  process.exit(0);
}

const files = fs.readdirSync(inbox).filter(f => /\.(mp4|mov|webm)$/i.test(f)).sort();
const assigned = new Map();
for (const f of [...files]) {
  const n = f.toLowerCase();
  const p = personas.find(x => !assigned.has(x.id) && (n.includes(x.id) || n.includes(x.name.split(' ')[0].toLowerCase())));
  if (p) { assigned.set(p.id, f); files.splice(files.indexOf(f), 1); }
}
for (const p of personas) if (!assigned.has(p.id) && files.length) assigned.set(p.id, files.shift());

for (const [id, f] of assigned) {
  fs.copyFileSync(path.join(inbox, f), path.join(raw, `${id}.mp4`));
  console.log(`${id} <- ${f}`);
}
if (!assigned.size) { console.error('No clips found in clips/inbox.'); process.exit(1); }
spawnSync(process.execPath, [path.join(__dirname, 'convert.js')], { stdio: 'inherit' });
