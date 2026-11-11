// AI-pinion: a chat that works out the most likely causes of a person's symptoms, and gives a top three.
// It is a computer program, not a doctor, and every result says so. Emergency warning signs are checked by
// fixed rules first, and the model never sees them.
//
// Each candidate is searched in recent PubMed articles. Statements about the articles must cite an article
// we sent, and statements without a valid citation are dropped.
//
// Off unless AI_PINION_ENABLED=true. Personal use only.

const { emergencyReason } = require('./triage');
const { articlesFor, sourceOf } = require('./pubmed');

const MODEL = 'claude-opus-5-5';
// After this many questions from the person, the chat must finish with three candidates
const MAX_USER_TURNS = 8;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARACTERS = 1500;
const ARTICLES_PER_CONDITION = 3;

const EMERGENCY_TEXT =
  'You described a warning sign that needs emergency care now. Call 911 or go to the nearest emergency room. AI-pinion will not continue.';

const SAFETY_NOTE =
  'AI-pinion is a computer program, not a doctor. These are possibilities to talk through with a clinician, not a diagnosis. Only a clinician who examines you can diagnose you. If symptoms are severe or sudden, call 911 or go to the nearest emergency room.';

const ASK_PROMPT = `You are AI-pinion, a computer program that helps a person work out the most likely causes of how they feel, so they can talk it through with a clinician. You are not a doctor.

While you are still asking questions:
- Ask ONE short, plain-language question at a time. Each question should help narrow the possibilities.
- Cover what is needed: where it is and what it feels like, when it started and how it has changed, what makes it better or worse, other symptoms (fever, rash, tiredness, weight change, swelling, changes to skin, nails or eyes), family history of similar problems, and what doctors or urgent care have already said, tried or ruled out.
- Do not name a condition while you are still asking questions.
- Do NOT recommend a treatment, a medication, a dose, or starting or stopping anything.

When you have enough to suggest three likely possibilities, or the person has answered enough, choose action "finish" and list exactly three possible medical conditions, most likely first. Explain each one in terms of what the person said. Do not claim certainty. If the information is thin, still give three, and say in "why" what is missing.
Respond only by calling the next_step tool.`;

const NEXT_STEP_TOOL = {
  name: 'next_step',
  description: 'Either ask the person one more question, or finish with three possible conditions.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['ask', 'finish'] },
      question: { type: 'string', description: 'When action is ask: one plain-language question. Otherwise empty.' },
      candidates: {
        type: 'array',
        description: 'When action is finish: exactly three possible conditions, most likely first. Otherwise empty.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The condition name as medical literature uses it, such as "Psoriatic arthritis".' },
            why: { type: 'string', description: 'Why this fits what the person said, in plain language. Refer to their words.' },
            ask_clinician: {
              type: 'array',
              items: { type: 'string' },
              description: 'Up to three questions to ask a clinician about this possibility.',
            },
          },
          required: ['name', 'why', 'ask_clinician'],
          additionalProperties: false,
        },
      },
    },
    required: ['action', 'question', 'candidates'],
    additionalProperties: false,
  },
};

const GROUND_PROMPT = `You summarize what published research articles say about possible conditions, for a person trying to understand their symptoms.

Rules you must follow:
- For each condition, use only the numbered articles listed under it. Do not add knowledge from anywhere else.
- Every paragraph must cite the IDs of the articles it comes from, such as S4. Leave out any paragraph you cannot tie to an article.
- If the articles do not describe how the condition shows up, say so in a paragraph that cites what you have, or leave it out.
- Do not say the person has any condition. Use words like "may", "could fit" or "is one possibility".
- Do NOT recommend a treatment, a medication, or a dose.
- Plain language. Keep each condition under 80 words.
- Respond only by calling the write_findings tool, with one entry per condition, using the condition names as given.`;

const FINDINGS_TOOL = {
  name: 'write_findings',
  description: 'Record a short summary, and what the articles say about each condition, with citations.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Two or three sentences: what the person described, and that these are possibilities, not a diagnosis.',
      },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            articles_say: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  source_ids: { type: 'array', items: { type: 'string' } },
                },
                required: ['text', 'source_ids'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'articles_say'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'candidates'],
    additionalProperties: false,
  },
};

// A simple cap per hour across the server, to limit model costs
const MAX_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;
let windowStart = Date.now();
let windowCount = 0;
function withinHourlyCap() {
  const now = Date.now();
  if (now - windowStart >= HOUR_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_HOUR) return false;
  windowCount += 1;
  return true;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

// The model needs alternating turns that start with the person. Empty and repeated turns are merged or dropped.
function normaliseMessages(raw) {
  const out = [];
  for (const m of raw) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = cleanText(m?.content, MAX_MESSAGE_CHARACTERS);
    if (!content) continue;
    if (out.length === 0 && role === 'assistant') continue;
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].content += `\n\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  return out;
}

function uniqueCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const name = cleanText(c?.name, 100);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      why: cleanText(c.why, 600),
      askClinician: (c.ask_clinician || []).map((q) => cleanText(q, 200)).filter(Boolean).slice(0, 3),
    });
    if (out.length === 3) break;
  }
  return out;
}

function transcriptOf(messages) {
  return messages.map((m) => `${m.role === 'user' ? 'Person' : 'AI-pinion'}: ${m.content}`).join('\n');
}

// Asks the next question, or finishes with three candidate conditions.
async function nextStep(client, messages, finishNow) {
  const modelMessages = messages.map((m) => ({ ...m }));
  if (finishNow) {
    const last = modelMessages[modelMessages.length - 1];
    last.content += '\n\n[Enough questions have been asked. Choose action "finish" now.]';
  }
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: ASK_PROMPT,
    tools: [NEXT_STEP_TOOL],
    tool_choice: { type: 'tool', name: NEXT_STEP_TOOL.name },
    messages: modelMessages,
  });
  if (response.stop_reason === 'refusal') return { refused: true };
  const toolUse = response.content.find((block) => block.type === 'tool_use' && block.name === NEXT_STEP_TOOL.name);
  return { input: toolUse?.input || null };
}

// Searches PubMed for each candidate, then has the model cite only those articles.
async function findingsFor(client, messages, candidates) {
  const articleById = new Map();
  const idsByCandidate = [];
  for (const candidate of candidates) {
    let articles = [];
    try {
      articles = await articlesFor(candidate.name, ARTICLES_PER_CONDITION);
    } catch (error) {
      console.error('PubMed lookup failed for a candidate:', error?.message);
    }
    const ids = articles.map((article) => {
      const id = `S${articleById.size + 1}`;
      articleById.set(id, article);
      return id;
    });
    idsByCandidate.push(ids);
  }

  const paragraphsFor = candidates.map(() => []);
  let summary = '';
  if (articleById.size > 0) {
    const articleText = candidates
      .map((candidate, i) => {
        const ids = idsByCandidate[i];
        const body = ids.length
          ? ids.map((id) => {
              const a = articleById.get(id);
              return `[${id}] ${a.title} (${a.journal}, ${a.year})\n${a.abstract}`;
            }).join('\n\n')
          : 'No recent articles were found for this condition.';
        return `Condition: ${candidate.name}\n${body}`;
      })
      .join('\n\n----\n\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: GROUND_PROMPT,
      tools: [FINDINGS_TOOL],
      tool_choice: { type: 'tool', name: FINDINGS_TOOL.name },
      messages: [{
        role: 'user',
        content: `What the person told us:\n"""\n${transcriptOf(messages)}\n"""\n\nArticles by condition:\n\n${articleText}`,
      }],
    });
    const toolUse = response.content.find((block) => block.type === 'tool_use' && block.name === FINDINGS_TOOL.name);
    const findings = toolUse?.input || {};
    summary = cleanText(findings.summary, 600);

    candidates.forEach((candidate, i) => {
      const entry =
        (findings.candidates || []).find((c) => String(c?.name || '').toLowerCase() === candidate.name.toLowerCase()) ||
        (findings.candidates || [])[i];
      const allowed = new Set(idsByCandidate[i]);
      let dropped = 0;
      for (const paragraph of entry?.articles_say || []) {
        const ids = (paragraph.source_ids || []).filter((id) => allowed.has(id));
        if (!paragraph.text || ids.length === 0) {
          dropped += 1;
          continue;
        }
        paragraphsFor[i].push({
          text: cleanText(paragraph.text, 800),
          sources: ids.map((id) => ({ id, ...sourceOf(articleById.get(id)) })),
        });
      }
      if (dropped > 0) console.log(`AI-pinion: dropped ${dropped} statement(s) without a valid citation`);
    });
  }

  return { summary, paragraphsFor, idsByCandidate, articleById };
}

function mountAiPinionRoutes(app, client) {
  // POST /api/ai-pinion/turn { messages: [{ role: 'user' | 'assistant', content: string }] }
  app.post('/api/ai-pinion/turn', async (req, res) => {
    if (process.env.AI_PINION_ENABLED !== 'true') {
      return res.status(503).json({ error: 'AI-pinion is not available yet.' });
    }
    const raw = Array.isArray(req.body?.messages) ? req.body.messages.slice(-MAX_MESSAGES) : [];
    const messages = normaliseMessages(raw);
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Tell AI-pinion what is going on first.' });
    }

    // Emergency rules run first, always, and never call the model
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    if (emergencyReason(userText)) {
      return res.json({ type: 'emergency', text: EMERGENCY_TEXT, safetyNote: SAFETY_NOTE });
    }

    if (!withinHourlyCap()) {
      return res.status(429).json({ error: 'AI-pinion is busy for now. Please try again later.' });
    }

    try {
      const userTurns = messages.filter((m) => m.role === 'user').length;
      const finishNow = userTurns >= MAX_USER_TURNS;

      const step = await nextStep(client, messages, finishNow);
      if (step.refused) {
        return res.status(422).json({ error: 'AI-pinion cannot help with this here. Please talk with a clinician.' });
      }
      const input = step.input;
      if (!input) return res.status(502).json({ error: 'AI-pinion could not respond. Please try again.' });

      if (input.action === 'ask' && !finishNow) {
        const question = cleanText(input.question, 500);
        if (!question) return res.status(502).json({ error: 'AI-pinion could not respond. Please try again.' });
        return res.json({ type: 'question', text: question });
      }

      const candidates = uniqueCandidates(input.candidates);
      if (candidates.length === 0) {
        return res.status(502).json({ error: 'AI-pinion could not work out possibilities yet. Please add a little more detail.' });
      }

      const { summary, paragraphsFor } = await findingsFor(client, messages, candidates);
      const sources = new Map();
      const results = candidates.map((candidate, i) => {
        const paragraphs = paragraphsFor[i];
        paragraphs.forEach((p) => p.sources.forEach((s) => sources.set(s.pmid, { id: s.id, title: s.title, journal: s.journal, year: s.year, url: s.url, pmid: s.pmid })));
        return {
          rank: i + 1,
          name: candidate.name,
          why: candidate.why,
          articlesSay: paragraphs,
          askClinician: candidate.askClinician,
          limitedEvidence: paragraphs.length === 0,
        };
      });

      res.json({
        type: 'result',
        summary: summary || 'These are possibilities based on what you told us, not a diagnosis.',
        candidates: results,
        sources: [...sources.values()],
        safetyNote: SAFETY_NOTE,
      });
    } catch (error) {
      console.error('AI-pinion turn failed:', error?.status || error?.message);
      res.status(502).json({ error: 'AI-pinion could not respond right now. Please try again.' });
    }
  });
}

module.exports = { mountAiPinionRoutes, normaliseMessages, uniqueCandidates };
