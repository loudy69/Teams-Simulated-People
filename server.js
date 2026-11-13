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
    await new Promise(r => { src.onended = r; src.start(ac.currentTime + 0.5); });
    await new Promise(r => setTimeout(r, 300));
    clearInterval(iv);
  };
  // Keep the context running even when the window is in the background
  setInterval(() => { if (ac.state !== 'running') ac.resume().catch(() => {}); }, 1000);
  const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const wantAudio = c && c.audio;
    const wantVideo = c && c.video;
    const s = wantVideo ? await orig({ ...c, audio: false }) : new MediaStream();
    if (wantAudio) { await ac.resume().catch(() => {}); dest.stream.getAudioTracks().forEach(t => s.addTrack(t.clone())); }
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

// Make sure the microphone is on. Returns true when it is confirmed (or was just switched) on.
async function setMic(page, wantOn) {
  return page.evaluate((on) => {
    const cands = [...document.querySelectorAll('#mic-button, [data-tid="toggle-mute"], [data-tid="prejoin-mic-toggle"], button[aria-label*="mic" i], [role="switch"][aria-label*="mic" i], [role="switch"][aria-label*="audio" i]')];
    const el = cands.find(e => e.offsetParent !== null);
    if (!el) return false;
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '')).toLowerCase();
    let isOn;
    if (el.getAttribute('role') === 'switch' || el.hasAttribute('aria-checked')) isOn = el.getAttribute('aria-checked') === 'true';
    else if (/unmute|turn on|mic is off|muted/.test(label) && !/^\s*mute\b/.test(label)) isOn = false;
    else if (/\bmute\b|turn off|mic is on/.test(label)) isOn = true;
    else isOn = el.getAttribute('aria-pressed') !== 'true';
    if (isOn !== on) { el.click(); return 'toggled'; }
    return true;
  }, wantOn).catch(() => false);
}

async function join(persona, url) {
  const clip = path.join(__dirname, 'clips', `${persona.id}.mjpeg`);
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
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
    await nameBox.fill(persona.name);
    // Computer audio ON with the microphone enabled (fed by the injected virtual mic)
    await clickFirst(page, ['[data-tid="prejoin-audio-option-computer"]', 'label:has-text("Computer audio")', 'text=Computer audio'], 5000);
    await setMic(page, true, 'prejoin');
    setStatus(persona.id, 'joining');
    await clickFirst(page, ['button:has-text("Join now")', '[data-tid="prejoin-join-button"]'], 30000);
    setStatus(persona.id, 'waiting in lobby - admit from the host');
    const inMeeting = page.locator('[data-tid="hangup-button"], #hangup-button, button[aria-label^="Leave"]').first();
    inMeeting.waitFor({ timeout: 0 }).then(async () => {
      for (let i = 0; i < 5; i++) { if (await setMic(page, true, 'meeting')) break; await page.waitForTimeout(1000); }
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
  const chosen = personas.slice(0, n).map((p, i) => ({ ...p, name: String(names[i] || '').trim().slice(0, 60) || p.name }));
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

const inMeeting = () => personas.filter(p => sessions.get(p.id)?.status === 'in meeting').map(p => ({ ...p, name: sessions.get(p.id).name || p.name }));
const allJoined = () => sessions.size > 0 && [...sessions.values()].every(s => s.status === 'in meeting');

app.post('/api/conversation/start', (req, res) => {
  const { industry, topic } = req.body;
  if (convo.state.running) return res.status(409).json({ error: 'Conversation already running' });
  if (!allJoined()) return res.status(409).json({ error: 'Wait until all participants are admitted into the meeting' });
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'Enter a topic brief' });
  const people = inMeeting();
  convo.run({
    industry: industry || 'General business', topic: topic.trim(), people, minutes: req.body.minutes,
    speak: async (id, buf) => {
      const page = sessions.get(id).page;
      await setMic(page, true); // unmute if Teams muted the guest
      await page.waitForTimeout(300);
      await page.evaluate(b => window.__speak(b), buf.toString('base64'));
    }
  });
  res.json({ ok: true });
});
app.post('/api/conversation/stop', (req, res) => { convo.state.stop = true; res.json({ ok: true }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Open http://localhost:' + PORT));
