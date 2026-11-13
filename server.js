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
  window.__vmic = { ac, dest };
  window.__speak = async (b64) => {
    await ac.resume();
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const buf = await ac.decodeAudioData(u8.buffer);
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest);
    await new Promise(r => { src.onended = r; src.start(); });
  };
  const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const wantAudio = c && c.audio;
    const s = await orig({ ...c, audio: false });
    if (wantAudio) dest.stream.getAudioTracks().forEach(t => s.addTrack(t));
    return s;
  };
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

async function join(persona, url) {
  const clip = path.join(__dirname, 'clips', `${persona.id}.mjpeg`);
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=ExternalProtocolDialog,MsEdgeProtocolLaunchPrompt', '--noerrdialogs', '--disable-external-intent-requests'];
  if (fs.existsSync(clip)) args.push(`--use-file-for-fake-video-capture=${clip}`);
  else console.warn(`No clip for ${persona.name} (run fetch-clips + convert); using test pattern.`);
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: false, args });
  sessions.set(persona.id, { status: 'launching', browser });
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
    await nameBox.fill(persona.name);
    // Computer audio ON with the microphone enabled (fed by the injected virtual mic)
    await clickFirst(page, ['[data-tid=\"prejoin-audio-option-computer\"]', 'label:has-text(\"Computer audio\")'], 5000);
    setStatus(persona.id, 'joining');
    await clickFirst(page, ['button:has-text("Join now")', '[data-tid="prejoin-join-button"]'], 30000);
    setStatus(persona.id, 'waiting in lobby - admit from the host');
    const inMeeting = page.locator('[data-tid=\"hangup-button\"], #hangup-button, button[aria-label^=\"Leave\"]').first();
    inMeeting.waitFor({ timeout: 0 }).then(async () => {
      setStatus(persona.id, 'in meeting');
      await page.locator('#microphone-button, [data-tid=\"toggle-mute\"]').first().evaluate(b => { if (b.getAttribute('aria-pressed') === 'false' || /unmute/i.test(b.getAttribute('aria-label') || '')) b.click(); }).catch(() => {});
    }).catch(() => {});
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  } catch (e) {
    setStatus(persona.id, `error: ${e.message.split('\n')[0]}`);
  }
}

app.get('/api/personas', (req, res) => res.json(personas.map(p => ({ ...p, hasClip: fs.existsSync(path.join(__dirname, 'clips', `${p.id}.mjpeg`)) }))));
app.get('/api/status', (req, res) => res.json(Object.fromEntries([...sessions].map(([k, v]) => [k, v.status]))));

app.post('/api/join', (req, res) => {
  const { meetingId, passcode, count } = req.body;
  const n = Math.min(12, Math.max(1, parseInt(count, 10) || 1));
  if (!meetingId || !passcode) return res.status(400).json({ error: 'meetingId and passcode required' });
  const url = joinUrl(meetingId, passcode);
  const chosen = personas.slice(0, n);
  chosen.forEach((p, i) => setTimeout(() => join(p, url), i * 2500)); // stagger launches
  res.json({ started: chosen.map(p => p.name) });
});

app.post('/api/leave', async (req, res) => {
  for (const [, s] of sessions) await s.browser?.close().catch(() => {});
  sessions.clear();
  res.json({ ok: true });
});

const ind = Object.keys(convo.INDUSTRIES).sort((a, b) => a.localeCompare(b));
app.get('/api/industries', (req, res) => res.json(ind.map(n => ({ name: n, brief: convo.INDUSTRIES[n] }))));
app.get('/api/conversation', (req, res) => res.json({ ...convo.state, ready: inMeeting().length > 0 && allJoined() }));

const inMeeting = () => personas.filter(p => sessions.get(p.id)?.status === 'in meeting');
const allJoined = () => sessions.size > 0 && [...sessions.values()].every(s => s.status === 'in meeting');

app.post('/api/conversation/start', (req, res) => {
  const { industry, topic } = req.body;
  if (convo.state.running) return res.status(409).json({ error: 'Conversation already running' });
  if (!allJoined()) return res.status(409).json({ error: 'Wait until all participants are admitted into the meeting' });
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Enter a topic brief' });
  const people = inMeeting();
  convo.run({
    industry: industry || 'General business', topic: topic.trim(), people,
    speak: async (id, buf) => { await sessions.get(id).page.evaluate(b => window.__speak(b), buf.toString('base64')); }
  });
  res.json({ ok: true });
});
app.post('/api/conversation/stop', (req, res) => { convo.state.stop = true; res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Open http://localhost:' + PORT));
