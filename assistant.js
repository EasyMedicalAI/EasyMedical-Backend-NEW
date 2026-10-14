// Turns a typed or dictated health note into structured log entries (weight, blood pressure,
// starting or stopping a medication). The app always shows these to the person before saving.

const ENTRY_TYPES = ['weight', 'blood_pressure', 'start_medication', 'stop_medication', 'unclear'];

const LOG_TOOL = {
  name: 'record_log_entries',
  description:
    'Record the health log entries the person described. Only include what they actually said. Never invent a value.',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ENTRY_TYPES },
            date: { type: 'string', description: 'YYYY-MM-DD. Use today when they said today or gave no date.' },
            weight_lbs: { type: 'number', description: 'Weight in pounds. Convert kilograms to pounds.' },
            systolic: { type: 'number', description: 'Top blood pressure number' },
            diastolic: { type: 'number', description: 'Bottom blood pressure number' },
            medication_name: { type: 'string', description: 'Medication name as stated, or the matching name from the current list' },
            dose: { type: 'string', description: 'Dose only if they stated one' },
            instructions: { type: 'string', description: 'How it is taken, only if they stated it' },
            message: { type: 'string', description: 'For unclear entries: a short question to ask the person' },
          },
          required: ['type'],
        },
      },
    },
    required: ['entries'],
  },
};

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const num = (value) => (typeof value === 'number' && isFinite(value) ? value : undefined);

// Checks values against plausible ranges. Anything outside them becomes an unclear entry instead of a saved value.
function normalizeEntries(raw, today) {
  return (Array.isArray(raw) ? raw : []).map((e) => {
    const date = isDate(e.date) ? e.date : today;
    if (e.type === 'weight') {
      const weight = num(e.weight_lbs);
      if (weight === undefined || weight < 50 || weight > 700) {
        return { type: 'unclear', message: 'What is your weight in pounds?' };
      }
      return { type: 'weight', date, weight_lbs: Math.round(weight * 10) / 10 };
    }
    if (e.type === 'blood_pressure') {
      const s = num(e.systolic);
      const d = num(e.diastolic);
      if (s === undefined || d === undefined || s < 60 || s > 260 || d < 30 || d > 160) {
        return { type: 'unclear', message: 'What are the top and bottom blood pressure numbers?' };
      }
      return { type: 'blood_pressure', date, systolic: s, diastolic: d };
    }
    if (e.type === 'start_medication' || e.type === 'stop_medication') {
      const name = clean(e.medication_name);
      if (!name) return { type: 'unclear', message: 'Which medication is it?' };
      return {
        type: e.type,
        date,
        medication_name: name,
        dose: clean(e.dose),
        instructions: clean(e.instructions),
      };
    }
    return { type: 'unclear', message: clean(e.message) || 'Could you say that another way?' };
  });
}

function mountAssistantRoutes(app, client) {
  app.post('/api/assistant/parse', async (req, res) => {
    try {
      const text = clean(req.body?.text);
      const today = isDate(req.body?.today) ? req.body.today : new Date().toISOString().slice(0, 10);
      const activeMedications = (Array.isArray(req.body?.activeMedications) ? req.body.activeMedications : [])
        .map(clean)
        .filter(Boolean)
        .slice(0, 100);

      if (!text) return res.status(400).json({ error: 'Please type something to log' });
      if (text.length > 500) return res.status(400).json({ error: 'Please keep it under 500 characters' });

      const prompt = `Today is ${today}.
The person's current medications are: ${activeMedications.length ? activeMedications.join(', ') : 'none listed'}.

Turn this message into log entries using the record_log_entries tool:
"${text}"

Rules:
- Only log what the person said. Never invent a dose, date, or value.
- One message can contain several entries. Return one entry for each.
- Stopping a medication: if the name matches one of the current medications, use that exact name.
- If anything is unclear, return an unclear entry with a short question to ask.
- Do not give medical advice.`;

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1000,
        tools: [LOG_TOOL],
        tool_choice: { type: 'tool', name: LOG_TOOL.name },
        messages: [{ role: 'user', content: prompt }],
      });

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse) return res.status(502).json({ error: 'Could not understand that. Please try again.' });

      res.json({ entries: normalizeEntries(toolUse.input?.entries, today) });
    } catch (error) {
      console.error('Assistant parse error:', error);
      res.status(500).json({ error: 'Could not process that right now. Please try again.' });
    }
  });
}

module.exports = { mountAssistantRoutes, normalizeEntries };
