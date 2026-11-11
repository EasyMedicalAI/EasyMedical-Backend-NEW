// Symptom triage: how urgently a person should get care, and which kind of clinician to see.
// It never names a condition, recommends a treatment, or gives a medication. Emergency warning signs are
// checked by fixed rules first, so they never depend on the model.
//
// Every reason must cite a trusted source from data/triage-sources.json. Reasons without a valid citation
// are dropped before they reach the person.
//
// The suggestion step is off unless TRIAGE_ENABLED=true. Sources marked as drafts are used only when
// TRIAGE_USE_DRAFT_SOURCES=true, which is for testing only.

const fs = require('fs');
const path = require('path');

const LIBRARY = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'triage-sources.json'), 'utf8'));
const USE_DRAFT_SOURCES = process.env.TRIAGE_USE_DRAFT_SOURCES === 'true';

const WHERE_TO_GO = [
  'emergency_room', 'urgent_care', 'primary_care', 'cardiology', 'dermatology', 'gastroenterology',
  'neurology', 'ob_gyn', 'ophthalmology', 'ent', 'orthopedics', 'psychiatry', 'rheumatology',
  'pediatrics', 'other_specialist',
];

const URGENCY = ['emergency', 'urgent_care_today', 'see_doctor_this_week', 'routine'];

// Warning signs that always mean emergency care now. Checked before any model call.
const EMERGENCY_PATTERNS = [
  /chest (pain|pressure|tightness)/i,
  /(trouble|difficulty) breathing|can.?t breathe|short(ness)? of breath/i,
  /face (is )?droop|arm (is )?(weak|numb)|slurred speech|sudden (weakness|numbness)|sudden confusion/i,
  /worst headache|sudden severe headache/i,
  /pass(ed|ing) out|fainted|unconscious|seizure/i,
  /severe bleeding|bleeding (that|which) won.?t stop|vomit(ing)? blood|coughing up blood/i,
  /throat (is )?(swelling|closing)|swollen (tongue|throat)|anaphyla/i,
  /stiff neck.*(fever|high temperature)|(fever|high temperature).*stiff neck/i,
  /suicid|kill myself|want to die|hurt myself|harm myself/i,
  /sudden (loss of )?vision|can.?t see/i,
];

function emergencyReason(text) {
  return EMERGENCY_PATTERNS.some((pattern) => pattern.test(text));
}

// Sources the person's areas point to. Only approved sources are used, unless the test switch is on.
function selectSources(areas, limit = 8) {
  const usable = LIBRARY.entries.filter((e) => e.reviewStatus === 'approved' || USE_DRAFT_SOURCES);
  const wanted = new Set(areas);
  return usable.filter((e) => (e.appliesTo?.areas || []).some((a) => wanted.has(a))).slice(0, limit);
}

const SYSTEM_PROMPT = `You help a person decide how urgently to get medical care and which kind of clinician to see.

Rules you must follow:
- Do NOT name a diagnosis or a condition. Describe what the person reported, not what it might be. Do not use words like "infection", "arthritis", or "fracture" for what might be causing it.
- Do NOT recommend a treatment, a medication, a dose, or stopping or starting anything.
- Choose the most urgent level the description could call for. When unsure, choose the more urgent level and say what is missing.
- If the description is unclear, say so, use low confidence, and ask for the details that would help.
- Use plain language. Refer to what the person said.
- Every reason must cite at least one source by its ID, such as S2, from the trusted sources listed below. If no listed source supports a reason, leave that reason out.
- Respond only by calling the record_triage tool.`;

const TRIAGE_TOOL = {
  name: 'record_triage',
  description: 'Record how urgently the person should be seen and which kind of clinician fits. No diagnosis.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      urgency: { type: 'string', enum: URGENCY, description: 'How soon the person should be seen.' },
      where_to_go: { type: 'string', enum: WHERE_TO_GO, description: 'The kind of clinician or place to go first.' },
      reasons: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'One plain-language reason, tied to what the person said.' },
            source_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'The IDs of the trusted sources that support this reason, such as S1.',
            },
          },
          required: ['text', 'source_ids'],
          additionalProperties: false,
        },
      },
      questions_for_clinician: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to five questions the person could ask at the visit.',
      },
      missing_information: {
        type: 'array',
        items: { type: 'string' },
        description: 'Details that would help a clinician, if the person knows them.',
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['urgency', 'where_to_go', 'reasons', 'questions_for_clinician', 'missing_information', 'confidence'],
    additionalProperties: false,
  },
};

const SAFETY_NOTE =
  'This is not a diagnosis. It helps you decide how soon to get care and which clinician to see. A clinician has to evaluate you. If your symptoms get worse or you feel unsafe, call 911 or go to the nearest emergency room.';

// A simple cap on suggestions per hour across the server, to limit model costs until sign-in exists
const MAX_PER_HOUR = 100;
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

// Keeps only reasons that cite a source we sent. Returns the reasons, and which sources they use.
function groundReasons(reasons, sources) {
  const byId = new Map(sources.map((s, i) => [`S${i + 1}`, s]));
  const grounded = [];
  for (const reason of reasons || []) {
    const ids = (reason.source_ids || []).filter((id) => byId.has(id));
    if (!reason.text || ids.length === 0) continue;
    grounded.push({ text: reason.text, sources: ids.map((id) => byId.get(id)) });
  }
  const used = new Map();
  grounded.forEach((g) => g.sources.forEach((s) => used.set(s.url, s)));
  return {
    reasons: grounded.map((g) => g.text),
    reasonSources: grounded.map((g) => g.sources.map((s) => ({ title: s.title, url: s.url }))),
    sources: [...used.values()].map((s) => ({ title: s.title, url: s.url })),
    dropped: (reasons || []).length - grounded.length,
  };
}

function mountTriageRoutes(app, client) {
  // POST /api/triage { description: string, areas?: string[] }
  app.post('/api/triage', async (req, res) => {
    const description = cleanText(req.body?.description, 2000);
    const areas = Array.isArray(req.body?.areas) ? req.body.areas.slice(0, 20).map((a) => cleanText(a, 60)) : [];
    if (!description) return res.status(400).json({ error: 'Describe what is hurting' });

    // Emergency rules run first, always, and never call the model
    if (emergencyReason(`${description} ${areas.join(' ')}`)) {
      return res.json({
        emergency: true,
        result: {
          urgency: 'emergency',
          where_to_go: 'emergency_room',
          reasons: ['You described a warning sign that needs emergency care now.'],
          reasonSources: [[]],
          sources: [],
          questions_for_clinician: [],
          missing_information: [],
          confidence: 'high',
        },
        safetyNote: SAFETY_NOTE,
      });
    }

    // The suggestion stays off until a sign-in is in place
    if (process.env.TRIAGE_ENABLED !== 'true') {
      return res.status(503).json({ error: 'This suggestion is not available yet.' });
    }

    // No trusted sources for these areas means no grounded reasons, so no suggestion
    const sources = selectSources(areas);
    if (sources.length === 0) {
      return res.status(422).json({ error: 'We don’t have trusted information for this yet. Please talk with a clinician.' });
    }

    if (!withinHourlyCap()) {
      return res.status(429).json({ error: 'The suggestion limit has been reached for now. Please try again later.' });
    }

    try {
      const sourceText = sources.map((s, i) => `[S${i + 1}] ${s.title} (${s.url})\n${s.excerpt}`).join('\n\n');
      const prompt = `Body areas the person picked: ${areas.length ? areas.join(', ') : 'none picked'}.\nWhat the person said, in their words:\n"""${description}"""\n\nTrusted sources:\n${sourceText}`;
      const response = await client.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: [TRIAGE_TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: prompt }],
      });

      if (response.stop_reason === 'refusal') {
        return res.status(422).json({ error: 'This question is outside what we can help with here. Please talk with a clinician.' });
      }
      const toolUse = response.content.find((block) => block.type === 'tool_use' && block.name === TRIAGE_TOOL.name);
      if (!toolUse) return res.status(502).json({ error: 'Could not work that out. Please try again.' });

      const result = toolUse.input || {};
      if (!URGENCY.includes(result.urgency) || !WHERE_TO_GO.includes(result.where_to_go)) {
        return res.status(502).json({ error: 'Could not work that out. Please try again.' });
      }

      const grounded = groundReasons(result.reasons, sources);
      if (grounded.dropped > 0) console.log(`Triage: dropped ${grounded.dropped} reason(s) without a valid source`);
      result.reasons = grounded.reasons.length
        ? grounded.reasons
        : ['There isn’t enough trusted information to explain this suggestion. Please talk with a clinician.'];
      result.reasonSources = grounded.reasonSources;
      result.sources = grounded.sources;

      res.json({ emergency: false, result, safetyNote: SAFETY_NOTE });
    } catch (error) {
      console.error('Triage failed:', error?.status || error?.message);
      res.status(502).json({ error: 'Could not work that out right now. Please try again.' });
    }
  });
}

module.exports = { mountTriageRoutes, emergencyReason, EMERGENCY_PATTERNS, selectSources, groundReasons };
