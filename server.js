const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const personas = require('./personas.json');
const convo = require('./conversation');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Virtual microphone: getUserMedia gets video from the fake device plus audio from a WebAudio destination we can play speech into
const AUDIO_INIT = `(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC(); const dest = ac.createMediaStreamDestination();
  const an = ac.createAnalyser(); an.fftSize = 512; // diagnostics: measures the level actually sent to the call
  window.__vmic = { ac, dest, an, peak: 0 };
  window.__speak = async (b64) => {
    await ac.resume();
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const buf = await ac.decodeAudioData(u8.buffer);
    const src = ac.createBufferSource(); src.buffer = buf;
    const gain = ac.createGain(); gain.gain.value = 1.0;
    src.connect(gain); gain.connect(dest); gain.connect(an);
    const data = new Uint8Array(an.fftSize);
    const iv = setInterval(() => { an.getByteTimeDomainData(data); let m = 0; for (const v of data) m = Math.max(m, Math.abs(v - 128)); window.__vmic.peak = Math.max(window.__vmic.peak, m); }, 50);
    // short lead-in so Teams' voice detection and gain control don't clip the first word
    await new Promise(r => { src.onended = r; src.start(    ac.currentTime + 0.3); });
        await new Promise(r => setTimeout(r, 150));
    clearInterval(iv);
  };
  // Keep the context running even when the window is in the background
  setInterval(() => { if (ac.state !== 'running') ac.resume().catch(() => {}); }, 1000);
  const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const wantAudio = c && c.audio;
    const wantVideo = c && c.video;
    const s = wantVideo ? await orig({ ...c, audio: false }) : new MediaStream();
    if (wantAudio) { await ac.resume().catch(() => {}); dest.stream.getAudioTracks().forEach(t => { const c = t.clone(); (window.__mics = window.__mics || []).push(c); s.addTrack(c); }); }
    return s;
  };
  // Reports whether Teams is currently sending our mic track: true = unmuted, false = muted, null = unknown
  window.__micOn = () => { const l = (window.__mics || []).filter(t => t.readyState === 'live'); return l.length ? l.some(t => t.enabled && !t.muted) : null; };
})();`;
const sessions = new Map(); // personaId -> { status, browser }
const setStatus = (id, status) => { const s = sessions.get(id) || {}; s.status = status; sessions.set(id, s); console.log(id, status); };

function joinUrl(meetingId, passcode) {
  const id = meetingId.replace(/\s+/g, '');
  // v2 web client URL with anon=true goes straight to the browser pre-join page (no desktop-app launcher)
  return `https://teams.microsoft.com/v2/?meetingjoin=true#/meet/${id}?p=${encodeURIComponent(passcode)}&anon=true&deeplinkId=${Date.now()}`;
}

async function clickFirst(page, locators, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const l of locators) {
      const el = page.locator(l).first();
      if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); return true; }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

const MIC_SELECTORS = ['#mic-button', '[data-tid="toggle-mute"]', '[data-tid="prejoin-mic-toggle"]', '[role="switch"][aria-label*="mic" i]', '[role="switch"][aria-label*="audio" i]', 'button[aria-label*="mute" i]', 'button[aria-label*="microphone" i]', 'button[aria-label^="mic" i]'];

async function findMic(page) {
  for (const s of MIC_SELECTORS) {
    const loc = page.locator(s);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  }
  return null;
}

// true = mic on (unmuted), false = off, null = unknown
async function micState(el) {
  return el.evaluate(e => {
    const label = ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.textContent || '')).toLowerCase().trim();
    if (/unmute|turn on|mic is off|microphone is off|is muted|currently muted/.test(label)) return false;
    if (/\bmute\b|turn off|mic is on|microphone is on|unmuted/.test(label)) return true;
    if (e.hasAttribute('aria-checked')) return e.getAttribute('aria-checked') === 'true';
    if (e.hasAttribute('aria-pressed')) return e.getAttribute('aria-pressed') !== 'true';
    return null;
  }).catch(() => null);
}

// Current mic state: prefers the real track state (is Teams sending our audio?), else the button label
async function curState(page, el) {
  if (el) { const b = await micState(el); if (b === true || b === false) return b; }
  const t = await page.evaluate(() => window.__micOn && window.__micOn()).catch(() => null);
  return t === true || t === false ? t : null;
}

const micLog = (msg) => { try { fs.appendFileSync(path.join(__dirname, 'mic-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

async function dumpControls(page, tag) {
  const info = await page.evaluate(() => [...document.querySelectorAll('button,[role="switch"],[role="button"],[role="checkbox"]')]
    .filter(e => /mic|mute|audio/i.test((e.getAttribute('aria-label') || '') + (e.id || '') + (e.getAttribute('data-tid') || '') + (e.title || '')))
    .map(e => e.outerHTML.slice(0, 260))).catch(() => []);
  try { fs.appendFileSync(path.join(__dirname, 'mic-debug.log'), `\n[${new Date().toISOString()}] ${tag}\n${info.join('\n')}\n`); } catch {}
}

// Set the microphone on/off. Verifies via the real track state / button; tries a real click, then Ctrl+Shift+M.
async function setMic(page, wantOn) {
  try {
    await page.bringToFront().catch(() => {});
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.mouse.move(400 + attempt * 20, 300).catch(() => {}); // wakes the auto-hiding call toolbar
      const el = await findMic(page);
      const st = await curState(page, el);
      const html = el ? await el.evaluate(e => e.outerHTML.slice(0, 200)).catch(() => '?') : 'NO BUTTON FOUND';
      micLog(`want=${wantOn} attempt=${attempt} state=${st} el=${html}`);
      if (st === wantOn) return true;
      if (el && attempt % 2 === 0) await el.click({ timeout: 3000, force: true }).catch(() => {});
      else { await page.mouse.click(5, 5).catch(() => {}); await page.keyboard.press('Control+Shift+M'); }
      // Slower PCs take longer to update Teams' mute state: wait for it to settle before any retry (a retry would toggle it back)
      for (let w = 0; w < 12; w++) {
        await page.waitForTimeout(500);
        const now = await curState(page, (await findMic(page)) || el);
        if (now === wantOn) { micLog(`want=${wantOn} confirmed after ${(w + 1) * 500}ms`); return true; }
      }
      micLog(`want=${wantOn} NOT confirmed after attempt ${attempt}`);
    }
  } catch (e) { console.warn('setMic', e.message.split('\n')[0]); }
  console.warn(`setMic: could not confirm mic ${wantOn ? 'on' : 'off'} (see mic-debug.log)`);
  await dumpControls(page, `could not set mic ${wantOn}`);
  return false;
}

async function join(persona, url) {
  const clip = path.join(__dirname, 'clips', `${persona.id}.mjpeg`);
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=ExternalProtocolDialog,MsEdgeProtocolLaunchPrompt', '--noerrdialogs', '--disable-external-intent-requests'];
  if (fs.existsSync(clip)) args.push(`--use-file-for-fake-video-capture=${clip}`);
  else console.warn(`No clip for ${persona.name} (run fetch-clips + convert); using test pattern.`);
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: false, args });
  sessions.set(persona.id, { status: 'launching', browser, name: persona.name });
  try {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1000, height: 700 } });
    await ctx.addInitScript(AUDIO_INIT);
    const page = await ctx.newPage();
    sessions.get(persona.id).page = page;
    setStatus(persona.id, 'opening meeting link');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Dismiss any "Open Microsoft Teams?" desktop prompt, then force the web option
    await page.keyboard.press('Escape').catch(() => {});
    await clickFirst(page, ['button:has-text("Continue on this browser")', 'a:has-text("Continue on this browser")', 'text=Continue on this browser', 'button:has-text("Join on the web instead")', 'text=Join on the web instead'], 25000);
    await page.keyboard.press('Escape').catch(() => {});
    const nameBox = page.locator('input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i]').first();
    await nameBox.waitFor({ timeout: 60000 });
    // Type the name with real keystrokes so Teams' own state registers it, and verify it stuck
    const setName = async () => {
      for (let i = 0; i < 6; i++) {
        const cur = await nameBox.inputValue().catch(() => '');
        if (cur === persona.name) return true;
        await nameBox.evaluate(el => { el.readOnly = false; el.removeAttribute('aria-readonly'); el.style.pointerEvents = ''; }).catch(() => {});
        await nameBox.click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(persona.name, { delay: 25 });
        await page.waitForTimeout(400);
      }
      return (await nameBox.inputValue().catch(() => '')) === persona.name;
    };
    // Lock the display name so it stays as entered in the web UI (no manual edits in the Teams window)
    const lockName = async () => {
      await setName();
      await nameBox.evaluate(el => { el.readOnly = true; el.setAttribute('aria-readonly', 'true'); }).catch(() => {});
    };
    await lockName();
    // Computer audio ON with the microphone enabled (fed by the injected virtual mic)
    await clickFirst(page, ['[data-tid="prejoin-audio-option-computer"]', 'label:has-text("Computer audio")', 'text=Computer audio'], 5000);
    await setMic(page, false, 'prejoin'); // join muted
    setStatus(persona.id, 'joining');
    await lockName().catch(() => {}); // Teams can reset the field when audio options change
    await clickFirst(page, ['button:has-text("Join now")', '[data-tid="prejoin-join-button"]'], 30000);
    setStatus(persona.id, 'waiting in lobby - admit from the host');
    const inMeeting = page.locator('[data-tid="hangup-button"], #hangup-button, button[aria-label^="Leave"]').first();
    inMeeting.waitFor({ timeout: 0 }).then(async () => {
      for (let i = 0; i < 5; i++) { await page.waitForTimeout(1000); if (await setMic(page, false, 'meeting')) break; }
      setStatus(persona.id, 'in meeting');
    }).catch(() => {});
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  } catch (e) {
    setStatus(persona.id, `error: ${e.message.split('\n')[0]}`);
  }
}

app.get('/api/personas', (req, res) => res.json(personas.map(p => ({ ...p, hasClip: fs.existsSync(path.join(__dirname, 'clips', `${p.id}.mjpeg`)) }))));
app.get('/api/status', (req, res) => res.json(Object.fromEntries([...sessions].map(([k, v]) => [k, v.status]))));
app.get('/api/names', (req, res) => res.json(Object.fromEntries([...sessions].map(([k, v]) => [k, v.name]))));

app.post('/api/join', (req, res) => {
  const { meetingId, passcode, count } = req.body;
  const n = Math.min(12, Math.max(1, parseInt(count, 10) || 1));
  if (!meetingId || !passcode) return res.status(400).json({ error: 'meetingId and passcode required' });
  const url = joinUrl(meetingId, passcode);
  const names = Array.isArray(req.body.names) ? req.body.names : [];
  const pick = Array.isArray(req.body.people) ? req.body.people : null; // [{id,name}] chosen individually
  if (pick) {
    const sel = pick.map(x => ({ p: personas.find(p => p.id === x.id), name: x.name })).filter(x => x.p).slice(0, 12);
    if (!sel.length) return res.status(400).json({ error: 'Select at least one person' });
    const picked = sel.map(x => ({ ...x.p, name: String(x.name || '').trim().slice(0, 60) || x.p.name }));
    picked.forEach((p, i) => setTimeout(() => join(p, url), i * 2500));
    return res.json({ started: picked.map(p => p.name) });
  }
  const chosen = personas.slice(0, n).map((p, i) => ({ ...p, name: String(names[i] || '').trim().slice(0, 60) || p.name }));
  chosen.forEach((p, i) => setTimeout(() => join(p, url), i * 2500)); // stagger launches
  res.json({ started: chosen.map(p => p.name) });
});

app.post('/api/leave', async (req, res) => {
  for (const [, s] of sessions) await s.browser?.close().catch(() => {});
  sessions.clear();
  res.json({ ok: true });
});

app.get('/api/conversation', (req, res) => res.json({ ...convo.state, ready: inMeeting().length > 0 && allJoined() }));

const inMeeting = () => personas.filter(p => sessions.get(p.id)?.status === 'in meeting').map(p => ({ ...p, name: sessions.get(p.id).name || p.name }));
const allJoined = () => sessions.size > 0 && [...sessions.values()].every(s => s.status === 'in meeting');

// Guests stay muted; each unmutes only while speaking, then mutes again
const speakFn = async (id, buf) => {
  const page = sessions.get(id).page;
  for (let i = 0; i < 2; i++) { if (await setMic(page, true)) break; }
  await page.waitForTimeout(500); // let Teams start sending mic audio before speech begins
  try { await page.evaluate(b => window.__speak(b), buf.toString('base64')); }
  finally { await page.waitForTimeout(200); await setMic(page, false); }
};

app.post('/api/script/start', (req, res) => {
  if (convo.state.running) return res.status(409).json({ error: 'Conversation already running' });
  if (!allJoined()) return res.status(409).json({ error: 'Wait until all participants are admitted into the meeting' });
  const script = String(req.body.script || '');
  if (!convo.parseScript(script).length) return res.status(400).json({ error: 'No lines found. Use a .txt file with lines like "Name: text".' });
  res.json({ ok: true });
    // Everyone goes on mute first; each speaker then unmutes only for their own line
    Promise.all(inMeeting().map(p => setMic(sessions.get(p.id).page, false))).finally(() =>
      convo.runScript({ script, people: inMeeting(), speak: speakFn }));
});
app.post('/api/conversation/stop', (req, res) => { convo.state.stop = true; res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Open http://localhost:' + PORT));
