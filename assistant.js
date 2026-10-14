// Turns a typed or dictated health note into structured log entries. The app always shows these
// to the person before saving anything.

const ENTRY_TYPES = [
  'weight',
  'blood_pressure',
  'height',
  'blood_type',
  'birthday',
  'gender',
  'start_medication',
  'stop_medication',
  'add_condition',
  'add_allergy',
  'unclear',
];

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENDERS = ['Male', 'Female', 'Other'];

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
            feet: { type: 'number', description: 'Height: feet part' },
            inches: { type: 'number', description: 'Height: inches part (0 to 11)' },
            blood_type: { type: 'string', enum: BLOOD_TYPES },
            birthday: { type: 'string', description: 'Date of birth as YYYY-MM-DD' },
            gender: { type: 'string', enum: GENDERS },
            medication_name: { type: 'string', description: 'Medication name as stated, or the matching name from the current list' },
            medication_kind: { type: 'string', enum: ['prescription', 'otc'], description: 'otc for over-the-counter medicines and supplements' },
            dose: { type: 'string', description: 'Dose only if they stated one' },
            instructions: { type: 'string', description: 'How it is taken, only if they stated it' },
            condition_name: { type: 'string', description: 'A condition or diagnosis they have' },
            allergy_name: { type: 'string', description: 'What they are allergic to' },
            allergy_reaction: { type: 'string', description: 'The reaction, only if they stated one' },
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

// Ages from birthday; anything outside 0 to 120 is treated as unclear
const birthdayIsPlausible = (day) => {
  const birth = new Date(`${day}T12:00:00`);
  const ageYears = (Date.now() - birth.getTime()) / (365.25 * 24 * 3600 * 1000);
  return !isNaN(birth.getTime()) && ageYears >= 0 && ageYears <= 120;
};

const unclear = (message) => ({ type: 'unclear', message });

// Checks each value against plausible ranges. Anything outside them becomes a question, not a saved value.
function normalizeEntries(raw, today) {
  return (Array.isArray(raw) ? raw : []).map((e) => {
    const date = isDate(e.date) ? e.date : today;
    switch (e.type) {
      case 'weight': {
        const weight = num(e.weight_lbs);
        if (weight === undefined || weight < 50 || weight > 700) return unclear('What is your weight in pounds?');
        return { type: 'weight', date, weight_lbs: Math.round(weight * 10) / 10 };
      }
      case 'blood_pressure': {
        const s = num(e.systolic);
        const d = num(e.diastolic);
        if (s === undefined || d === undefined || s < 60 || s > 260 || d < 30 || d > 160) {
          return unclear('What are the top and bottom blood pressure numbers?');
        }
        return { type: 'blood_pressure', date, systolic: s, diastolic: d };
      }
      case 'height': {
        const feet = num(e.feet);
        const inches = num(e.inches) ?? 0;
        if (feet === undefined || feet < 3 || feet > 8 || inches < 0 || inches > 11) {
          return unclear('What is your height in feet and inches?');
        }
        return { type: 'height', feet, inches };
      }
      case 'blood_type':
        return BLOOD_TYPES.includes(e.blood_type)
          ? { type: 'blood_type', blood_type: e.blood_type }
          : unclear('What is your blood type? (for example O+ or AB-)');
      case 'birthday':
        return isDate(e.birthday) && birthdayIsPlausible(e.birthday)
          ? { type: 'birthday', birthday: e.birthday }
          : unclear('What is your date of birth? (for example 09/12/1987)');
      case 'gender':
        return GENDERS.includes(e.gender) ? { type: 'gender', gender: e.gender } : unclear('What is your sex? (Male, Female, or Other)');
      case 'start_medication':
      case 'stop_medication': {
        const name = clean(e.medication_name);
        if (!name) return unclear('Which medication is it?');
        return {
          type: e.type,
          date,
          medication_name: name,
          medication_kind: e.medication_kind === 'otc' ? 'otc' : 'prescription',
          dose: clean(e.dose),
          instructions: clean(e.instructions),
        };
      }
      case 'add_condition': {
        const name = clean(e.condition_name);
        return name ? { type: 'add_condition', condition_name: name } : unclear('What is the condition?');
      }
      case 'add_allergy': {
        const name = clean(e.allergy_name);
        return name
          ? { type: 'add_allergy', allergy_name: name, allergy_reaction: clean(e.allergy_reaction) }
          : unclear('What are you allergic to?');
      }
      default:
        return unclear(clean(e.message) || 'Could you say that another way?');
    }
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
        .slice(0, 200);

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
- Over-the-counter medicines and supplements use medication_kind "otc".
- If anything is unclear, return an unclear entry with a short question to ask.
- Do not give medical advice.`;

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1200,
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
