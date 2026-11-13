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
function llmConfig() {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN;
  const gh = !process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY && process.env.GITHUB_TOKEN;
  return {
    key,
    endpoint: process.env.LLM_ENDPOINT || (gh ? 'https://models.github.ai/inference/chat/completions' : 'https://api.openai.com/v1/chat/completions'),
    model: process.env.LLM_MODEL || (gh ? 'openai/gpt-4o-mini' : 'gpt-4o-mini')
  };
}

async function llm(messages) {
  const c = llmConfig();
  if (!c.key) throw new Error('No LLM key set. Set OPENAI_API_KEY (or LLM_API_KEY / GITHUB_TOKEN) before starting the service.');
  const r = await fetch(c.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
    body: JSON.stringify({ model: c.model, messages, temperature: 0.9, response_format: { type: 'json_object' } })
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`LLM ${r.status}: ${t.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(t); } catch { throw new Error(`LLM returned non-JSON: ${t.slice(0, 100)}`); }
  return JSON.parse(j.choices[0].message.content);
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

async function run({ industry, topic, people, speak }) {
  // people: [{id,name,voice}] who are in the meeting; speak(id, mp3Buffer) resolves when audio finished
  Object.assign(state, { running: true, stop: false, transcript: [], error: null, speaking: null });
  try {
    const names = people.map(p => p.name);
    const cast = await llm([
      { role: 'system', content: 'You design realistic business meeting casts. Reply with JSON only.' },
      { role: 'user', content: `Industry: ${industry}. Topic: ${topic}. Participants: ${names.join(', ')}. Give each a plausible job title and a one-sentence stance/concern on the topic, differing between people. JSON: {"cast":[{"name":"","role":"","stance":""}]}` }
    ]);
    const roles = Object.fromEntries((cast.cast || []).map(c => [c.name, c]));
    const castText = names.map(n => `- ${n}: ${roles[n]?.role || 'Team member'}; ${roles[n]?.stance || ''}`).join('\n');
    const maxTurns = Math.min(60, parseInt(process.env.MAX_TURNS, 10) || 30);

    const nextLine = async () => {
      const last = state.transcript[state.transcript.length - 1];
      const recent = state.transcript.slice(-8).map(t => `${t.speaker}: ${t.text}`).join('\n');
      const n = state.transcript.length;
      const r = await llm([
        { role: 'system', content: `You write the next line of a natural, realistic ${industry} business meeting held on Microsoft Teams. Participants:\n${castText}\nRules: the next speaker must NOT be ${last ? last.speaker : 'anyone in particular'} (the previous speaker). ${n === 0 ? 'The first line is the chair opening the meeting and setting the agenda.' : 'The speaker must directly respond to the previous speaker by name or point, then add something new (agree, challenge, ask a question, or propose an action).'} ${n >= maxTurns - 2 ? 'Begin wrapping up with actions and thanks.' : ''} Speak naturally like a person: conversational, 1-3 short sentences, max 45 words, no stage directions. JSON only: {"speaker":"<exact participant name>","text":"..."}` },
        { role: 'user', content: `Topic brief: ${topic}\n\nConversation so far:\n${recent || '(meeting just started)'}` }
      ]);
      let sp = people.find(p => p.name === r.speaker);
      if (!sp || (last && sp.name === last.speaker)) {
        const lastSeen = name => state.transcript.map(t => t.speaker).lastIndexOf(name);
        sp = people.filter(p => !last || p.name !== last.speaker).sort((a, b) => lastSeen(a.name) - lastSeen(b.name))[0];
      }
      const text = String(r.text || '').trim();
      return { sp, text, audio: tts(text, sp.voice) };
    };

    let pending = nextLine();
    while (!state.stop && state.transcript.length < maxTurns) {
      const { sp, text, audio } = await pending;
      const buf = await audio;
      state.transcript.push({ speaker: sp.name, text });
      // generate the next line while this one is spoken, but its text depends on this line
      pending = state.transcript.length < maxTurns ? nextLine() : null;
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
