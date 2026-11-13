// Generates a silent "listening" talking-head clip per persona using D-ID (https://docs.d-id.com).
// Put a front-facing headshot at clips/images/p01.jpg ... p12.jpg (AI-generated or licensed faces),
// set DID_API_KEY (the base64 "user:pass" key from the D-ID studio), then: npm run generate-avatars
const fs = require('fs');
const path = require('path');
const personas = require('../personas.json');

const key = process.env.DID_API_KEY;
if (!key) { console.error('Set DID_API_KEY first.'); process.exit(1); }
const headers = { Authorization: `Basic ${key}` };
const root = path.join(__dirname, '..', 'clips');
const raw = path.join(root, 'raw');
fs.mkdirSync(raw, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function uploadImage(file) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(file)]), path.basename(file));
  const r = await fetch('https://api.d-id.com/images', { method: 'POST', headers, body: form });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
  return (await r.json()).url;
}

async function generate(p) {
  const out = path.join(raw, `${p.id}.mp4`);
  const img = path.join(root, 'images', `${p.id}.jpg`);
  if (fs.existsSync(out)) return;
  if (!fs.existsSync(img)) return console.warn(`Missing ${img}`);
  const source_url = await uploadImage(img);
  // Silent SSML keeps the face idle: blinking, head sway, subtle expressions.
  const r = await fetch('https://api.d-id.com/talks', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_url,
      script: { type: 'text', ssml: true, input: '<speak><break time="9s"/></speak>',
        provider: { type: 'microsoft', voice_id: 'en-US-JennyNeural' } },
      config: { stitch: true }
    })
  });
  if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
  const { id } = await r.json();
  for (;;) {
    await sleep(4000);
    const t = await (await fetch(`https://api.d-id.com/talks/${id}`, { headers })).json();
    if (t.status === 'done') { fs.writeFileSync(out, Buffer.from(await (await fetch(t.result_url)).arrayBuffer())); break; }
    if (t.status === 'error' || t.status === 'rejected') throw new Error(JSON.stringify(t.error || t));
  }
  console.log(`${p.name}: done`);
}

(async () => {
  for (const p of personas) await generate(p).catch(e => console.error(`${p.name}: ${e.message}`));
})();
