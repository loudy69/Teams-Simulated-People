const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const personas = require('./personas.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    const ctx = await browser.newContext({ permissions: ['camera'], viewport: { width: 1000, height: 700 } });
    const page = await ctx.newPage();
    setStatus(persona.id, 'opening meeting link');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Dismiss any "Open Microsoft Teams?" desktop prompt, then force the web option
    await page.keyboard.press('Escape').catch(() => {});
    await clickFirst(page, ['button:has-text("Continue on this browser")', 'a:has-text("Continue on this browser")', 'text=Continue on this browser', 'button:has-text("Join on the web instead")', 'text=Join on the web instead'], 25000);
    await page.keyboard.press('Escape').catch(() => {});
    const nameBox = page.locator('input[data-tid="prejoin-display-name-input"], input[placeholder*="name" i]').first();
    await nameBox.waitFor({ timeout: 60000 });
    await nameBox.fill(persona.name);
    setStatus(persona.id, 'setting audio to No audio');
    await clickFirst(page, ['[data-tid="prejoin-audio-option-noaudio"]', 'label:has-text("Don\'t use audio")', 'label:has-text("No audio")', 'text=Don\'t use audio', 'text=No audio'], 8000);
    setStatus(persona.id, 'joining');
    await clickFirst(page, ['button:has-text("Join now")', '[data-tid="prejoin-join-button"]'], 30000);
    setStatus(persona.id, 'joined (or waiting in lobby - admit from the host)');
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

app.listen(3000, () => console.log('Open http://localhost:3000'));
