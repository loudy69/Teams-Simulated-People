const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INDUSTRIES = {
  'Automotive': '',
  'Central Government (UK)': '',
  'Consumer goods': '',
  'Defense': '',
  'Education': '',
  'Energy and Resources': '',
  'Financial Services': '',
  'Health': '',
  'Insurance': 'A customer policy complaint, and a major claims backlog caused by IT system issues and how to resolve it.',
  'Local Government (LRG)': '',
  'Manufacturing': '',
  'Media': '',
  'Non-Profit': '',
  'Professional Services': '',
  'Public Services & National Security': '',
  'Retail': 'Ongoing supplier issues: late deliveries, quality problems and what to do about them.',
  'Telecommunications': '',
  'Travel, Transport & Hospitality': ''
};

// --- LLM (any OpenAI-compatible chat completions endpoint) ---
// Foundry Local (on-device, no token cost) is preferred when running; set LLM_PROVIDER=cloud to skip it.
let local = null; // {endpoint, model} | false
async function detectFoundry() {
  if (local !== null) return local;
  local = false;
  if ((process.env.LLM_PROVIDER || '') === 'cloud' || process.env.LLM_ENDPOINT) return local;
  const bases = new Set([process.env.FOUNDRY_URL, 'http://127.0.0.1:5272'].filter(Boolean));
  try {
    const out = await new Promise(res => { const p = spawn('foundry', ['server', 'status'], { shell: true }); let o = ''; p.stdout.on('data', d => o += d); p.on('error', () => res('')); p.on('close', () => res(o)); setTimeout(() => { p.kill(); res(o); }, 8000); });
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) bases.add(m[0]);
  } catch {}
  // Only downloaded (cached) chat models can run; prefer instruct models, skip reasoning models
  let cached = [];
  try {
    const out = await new Promise(res => { const p = spawn('foundry', ['model', 'list', '-o', 'json'], { shell: true }); let o = ''; p.stdout.on('data', d => o += d); p.on('error', () => res('')); p.on('close', () => res(o)); setTimeout(() => { p.kill(); res(o); }, 15000); });
    cached = JSON.parse(out.slice(out.indexOf('{'))).models.filter(m => m.cached && m.type === 'Chat' && !/r1|reasoning/i.test(m.id));
  } catch {}
  const want = process.env.FOUNDRY_MODEL;
  const rank = m => (want && m.id.toLowerCase().startsWith(want.toLowerCase()) ? -1 : 0) || -m.fileSizeMb;
  const pick = cached.sort((a, b) => rank(a) - rank(b))[0];
  if (!pick) return local;
  await new Promise(res => { const p = spawn('foundry', ['model', 'load', pick.id], { shell: true }); p.on('error', res); p.on('close', res); setTimeout(res, 120000); });
  for (const b of bases) {
    try {
      const r = await fetch(`${b}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) { local = { endpoint: `${b}/v1/chat/completions`, model: pick.id }; console.log('LLM: Foundry Local', pick.id); return local; }
    } catch {}
  }  return local;
}

function llmConfig() {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN;
  const gh = !process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY && process.env.GITHUB_TOKEN;
  return {
    key,
    endpoint: process.env.LLM_ENDPOINT || (gh ? 'https://models.github.ai/inference/chat/completions' : 'https://api.openai.com/v1/chat/completions'),
    model: process.env.LLM_MODEL || (gh ? 'openai/gpt-4o-mini' : 'gpt-4o-mini')
  };
}

async function llm(messages, plain = false) {
  const f = await detectFoundry();
  const c = f ? { ...f, key: 'local' } : llmConfig();
  if (!c.key) throw new Error('No LLM available. Start Foundry Local, or set OPENAI_API_KEY (or LLM_API_KEY / GITHUB_TOKEN).');
  const body = { model: c.model, messages, temperature: 0.9 };
  if (!f && !plain) body.response_format = { type: 'json_object' }; if (f) body.max_tokens = plain ? 120 : 700;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(c.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` }, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`LLM ${r.status}: ${t.slice(0, 200)}`);
    try {
      const content = JSON.parse(t).choices[0].message.content;
      if (plain) return content;
      const m = content.match(/\{[\s\S]*\}/); // local models often wrap JSON in code fences
      return JSON.parse(m[0]);
    } catch { /* retry on malformed JSON */ }
  }
  throw new Error('LLM did not return valid JSON');
}

// --- Neural TTS via Edge read-aloud voices (python edge-tts) ---
function tts(text, voice) {
  const out = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  return new Promise((resolve, reject) => {
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const p = spawn(py, ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', out]);
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`edge-tts failed: ${err.slice(-200)}`));
      const buf = fs.readFileSync(out); fs.unlinkSync(out); resolve(buf);
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = { running: false, stop: false, transcript: [], error: null, speaking: null };

async function run({ industry, topic, people, speak, ...opts }) {
  // people: [{id,name,voice}] who are in the meeting; speak(id, mp3Buffer) resolves when audio finished
  Object.assign(state, { running: true, stop: false, transcript: [], error: null, speaking: null });
  try {
    const names = people.map(p => p.name);
    let cast = {};
    try {
      cast = await llm([
        { role: 'system', content: 'You design realistic business meeting casts. Reply with JSON only.' },
        { role: 'user', content: `Industry: ${industry}. Topic: ${topic}. Participants: ${names.join(', ')}. Give each a plausible job title and a one-sentence stance/concern on the topic, differing between people. JSON: {"cast":[{"name":"","role":"","stance":""}]}` }
      ]);
    } catch (e) { console.warn('cast generation skipped:', e.message); }
    const roles = Object.fromEntries((cast.cast || []).map(c => [c.name, c]));
    const castText = names.map(n => `- ${n}: ${roles[n]?.role || 'Team member'}; ${roles[n]?.stance || ''}`).join('\n');
    const minutes = Math.min(60, Math.max(0, parseFloat(opts.minutes) || 0));
    const maxTurns = minutes ? 60 : Math.min(60, parseInt(process.env.MAX_TURNS, 10) || 30);
    const deadline = minutes ? Date.now() + minutes * 60000 : 0;

    // The speaker is chosen in code (never the previous speaker, rarely the one before), so the model only writes text
    const pickSpeaker = () => {
      const tr = state.transcript, last = tr.length ? tr[tr.length - 1].speaker : null, prev = tr.length > 1 ? tr[tr.length - 2].speaker : null;
      if (!tr.length) return people[0];
      let pool = people.filter(p => p.name !== last && (people.length < 3 || p.name !== prev));
      if (!pool.length) pool = people.filter(p => p.name !== last);
      const seen = n => tr.map(t => t.speaker).lastIndexOf(n);
      pool.sort((a, b) => seen(a.name) - seen(b.name));
      return pool[Math.floor(Math.random() * Math.min(2, pool.length))];
    };
    const clean = (txt, name) => {
      let s = String(txt || '').replace(/```[a-z]*/gi, '').replace(/\s+/g, ' ').trim();
      const nameRe = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      s = s.replace(new RegExp(`^(?:(?:${nameRe})\\s*:\\s*)+`, 'i'), '');
      const m = s.search(new RegExp(`(?:${nameRe})\\s*:`, 'i'));
      if (m > 0) s = s.slice(0, m); // model role-played other attendees: keep only this speaker's words
      s = s.replace(/^["“]|["”]$/g, '').trim();
      const sentences = s.match(/[^.!?]+[.!?]+/g) || [s];
      return sentences.slice(0, 3).join(' ').trim();
    };

    const nextLine = async () => {
      const last = state.transcript[state.transcript.length - 1];
      const sp = pickSpeaker();
      const recent = state.transcript.slice(-8).map(t => `${t.speaker}: ${t.text}`).join('\n');
      const n = state.transcript.length;
      const final = !!deadline && n > 0 && Date.now() > deadline - 35000; // closing line is generated while the previous one plays
      const me = roles[sp.name];
      let text = '';
      const angles = ['raise a specific concern', 'ask a pointed question', 'propose a concrete next action', 'share a relevant example or figure', 'respectfully disagree and explain why', 'summarise and ask for a decision'];
      const words = s => new Set(s.toLowerCase().match(/[a-z']{4,}/g) || []);
      const tooSimilar = s => state.transcript.slice(-6).some(t => { const a = words(s), b = words(t.text); let k = 0; a.forEach(w => b.has(w) && k++); return k / Math.max(1, Math.min(a.size, b.size)) > 0.6; });
      for (let i = 0; i < 6 && (text.length < 8 || tooSimilar(text)); i++) {
        const angle = n === 0 ? '' : ` This time, ${angles[(n + i) % angles.length]}. Do not repeat or paraphrase anything already said.`;
        text = clean(await llm([
          { role: 'system', content: `You are ${sp.name}${me?.role ? ', ' + me.role : ''}, in a realistic ${industry} business meeting on Microsoft Teams. ${me?.stance ? 'Your view: ' + me.stance + ' ' : ''}Attendees:\n${castText}\n${n === 0 ? 'You are chairing: open the meeting, greet everyone and set the agenda.' : `Respond directly to ${last.speaker}'s last point, then add something new (agree, challenge, ask a question or propose an action).`} ${final || n >= maxTurns - 2 ? 'This is the closing remark: thank everyone, state the key next action and end the meeting.' : deadline ? `The meeting is short (${minutes} minutes), so keep it focused and move quickly to decisions.` : ''} Speak naturally and conversationally in 1-3 short sentences, maximum 45 words. Reply with ONLY the words you say: no name prefix, no quotes, no stage directions.${angle}` },
          { role: 'user', content: `Topic brief: ${topic}\n\nConversation so far:\n${recent || '(meeting just started)'}\n\n${sp.name}:` }
        ], true), sp.name);
      }
      if (text.length < 8) throw new Error('LLM returned no usable dialogue');
      return { sp, text, final, audio: tts(text, sp.voice) };
    };
    let pending = nextLine();
    while (!state.stop && state.transcript.length < maxTurns) {
      const { sp, text, audio, final } = await pending;
      const buf = await audio;
      state.transcript.push({ speaker: sp.name, text });
      // generate the next line while this one is spoken, but its text depends on this line
      pending = !final && state.transcript.length < maxTurns ? nextLine() : null;
      pending?.catch(() => {});
      state.speaking = sp.name;
      await speak(sp.id, buf); // returns after playback ends: nobody else speaks meanwhile
      state.speaking = null;
      if (!pending) break;
      await sleep(500 + Math.random() * 700);
    }
  } catch (e) {
    state.error = e.message;
    console.error('conversation error', e);
  } finally {
    state.running = false; state.speaking = null;
  }
}

module.exports = { INDUSTRIES, state, run };
