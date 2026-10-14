// Turns a typed or dictated health note into structured log entries. The app always shows these
// to the person before saving anything.

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENDERS = ['Male', 'Female', 'Other'];

const ENTRY_TYPES = [
  'weight', 'blood_pressure', 'height', 'blood_type', 'birthday', 'gender',
  'start_medication', 'stop_medication', 'add_condition', 'add_allergy',
  'remove_condition', 'remove_allergy',
  'log_sleep', 'log_exercise', 'log_meal',
  'add_appointment', 'add_vaccine', 'add_emergency_contact', 'add_insurance', 'set_pharmacy',
  'add_surgery', 'add_family_history', 'add_past_condition', 'add_hospitalization', 'add_screening',
  'unclear',
];

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
            date: { type: 'string', description: 'YYYY-MM-DD. For a reading or change: the day it happened (today if they said today or gave no date). For events: the event date.' },
            weight_lbs: { type: 'number', description: 'Weight in pounds. Convert kilograms to pounds.' },
            systolic: { type: 'number' },
            diastolic: { type: 'number' },
            feet: { type: 'number' },
            inches: { type: 'number', description: 'Inches part of height (0 to 11)' },
            blood_type: { type: 'string', enum: BLOOD_TYPES },
            birthday: { type: 'string', description: 'YYYY-MM-DD' },
            gender: { type: 'string', enum: GENDERS },
            medication_name: { type: 'string', description: 'Use the exact name from the current list when it matches' },
            medication_kind: { type: 'string', enum: ['prescription', 'otc'] },
            dose: { type: 'string' },
            instructions: { type: 'string' },
            name: { type: 'string', description: 'Condition, allergy, vaccine, surgery, contact, hospital reason, or screening name, as stated' },
            reaction: { type: 'string', description: 'Allergy reaction, only if stated' },
            time: { type: 'string', description: 'Appointment time, for example 2:00 PM, only if stated' },
            doctor_name: { type: 'string' },
            specialty: { type: 'string' },
            next_due: { type: 'string', description: 'Vaccine next due date, YYYY-MM-DD, only if stated' },
            relationship: { type: 'string' },
            phone: { type: 'string' },
            provider: { type: 'string', description: 'Insurance company' },
            member_id: { type: 'string' },
            group_number: { type: 'string' },
            address: { type: 'string', description: 'Pharmacy address, only if stated' },
            family_member: { type: 'string', description: 'Who in the family, for example mother' },
            notes: { type: 'string' },
            hours: { type: 'number', description: 'Hours of sleep (for example 7.5)' },
            minutes: { type: 'number', description: 'Minutes of exercise' },
            activity: { type: 'string', description: 'The kind of exercise, for example walking or cycling' },
            meal: { type: 'string', description: 'What they ate or drank, in plain words' },
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
const unclear = (message) => ({ type: 'unclear', message });

// Birthdays must fall within a human lifespan
const birthdayIsPlausible = (day) => {
  const birth = new Date(`${day}T12:00:00`);
  const ageYears = (Date.now() - birth.getTime()) / (365.25 * 24 * 3600 * 1000);
  return !isNaN(birth.getTime()) && ageYears >= 0 && ageYears <= 120;
};

// Checks each entry and its values. Anything missing or implausible becomes a question, never a saved value.
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
          type: e.type, date, medication_name: name,
          medication_kind: e.medication_kind === 'otc' ? 'otc' : 'prescription',
          dose: clean(e.dose), instructions: clean(e.instructions),
        };
      }
      case 'add_condition': {
        const name = clean(e.name);
        return name ? { type: 'add_condition', condition_name: name } : unclear('What is the condition?');
      }
      case 'add_allergy': {
        const name = clean(e.name);
        return name ? { type: 'add_allergy', allergy_name: name, allergy_reaction: clean(e.reaction) } : unclear('What are you allergic to?');
      }
      case 'remove_condition': {
        const name = clean(e.name);
        return name ? { type: 'remove_condition', condition_name: name } : unclear('Which condition should I remove?');
      }
      case 'remove_allergy': {
        const name = clean(e.name);
        return name ? { type: 'remove_allergy', allergy_name: name } : unclear('Which allergy should I remove?');
      }
      case 'log_sleep': {
        const hours = num(e.hours);
        if (hours === undefined || hours < 0 || hours > 24) return unclear('How many hours did you sleep?');
        return { type: 'log_sleep', date, hours: Math.round(hours * 10) / 10 };
      }
      case 'log_exercise': {
        const minutes = num(e.minutes);
        if (minutes === undefined || minutes <= 0 || minutes > 1440) return unclear('How many minutes did you exercise?');
        return { type: 'log_exercise', date, minutes: Math.round(minutes), activity: clean(e.activity) };
      }
      case 'log_meal': {
        const meal = clean(e.meal) || clean(e.name);
        return meal ? { type: 'log_meal', date, meal } : unclear('What did you eat or drink?');
      }
      case 'add_appointment': {
        if (!isDate(e.date)) return unclear('What is the date of the appointment?');
        return { type: 'add_appointment', date: e.date, time: clean(e.time), doctor_name: clean(e.doctor_name), specialty: clean(e.specialty) };
      }
      case 'add_vaccine': {
        const name = clean(e.name);
        if (!name) return unclear('Which vaccine was it?');
        if (!isDate(e.date)) return unclear(`When did you get the ${name} vaccine?`);
        return { type: 'add_vaccine', vaccine_name: name, date: e.date, next_due: isDate(e.next_due) ? e.next_due : '' };
      }
      case 'add_emergency_contact': {
        const name = clean(e.name);
        const phone = clean(e.phone);
        if (!name || !phone) return unclear('What is the emergency contact’s name and phone number?');
        return { type: 'add_emergency_contact', contact_name: name, relationship: clean(e.relationship), phone };
      }
      case 'add_insurance': {
        const provider = clean(e.provider);
        return provider
          ? { type: 'add_insurance', provider, member_id: clean(e.member_id), group_number: clean(e.group_number) }
          : unclear('What is the insurance company?');
      }
      case 'set_pharmacy': {
        const name = clean(e.name);
        const phone = clean(e.phone);
        if (!name || !phone) return unclear('What is the pharmacy name and phone number?');
        return { type: 'set_pharmacy', pharmacy_name: name, pharmacy_address: clean(e.address), pharmacy_phone: phone };
      }
      case 'add_surgery': {
        const name = clean(e.name);
        if (!name) return unclear('What was the surgery?');
        return isDate(e.date) ? { type: 'add_surgery', surgery_name: name, date: e.date } : unclear(`When was your ${name}?`);
      }
      case 'add_family_history': {
        const member = clean(e.family_member);
        const condition = clean(e.name);
        return member && condition
          ? { type: 'add_family_history', family_member: member, condition_name: condition }
          : unclear('Which family member had which condition?');
      }
      case 'add_past_condition': {
        const name = clean(e.name);
        return name ? { type: 'add_past_condition', condition_name: name } : unclear('What is the past condition?');
      }
      case 'add_hospitalization': {
        const reason = clean(e.name);
        return reason && isDate(e.date)
          ? { type: 'add_hospitalization', reason, date: e.date }
          : unclear('Why were you in the hospital, and when?');
      }
      case 'add_screening': {
        const name = clean(e.name);
        return name && isDate(e.date)
          ? { type: 'add_screening', screening_type: name, date: e.date, notes: clean(e.notes) }
          : unclear('Which screening was it, and when?');
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
        .map(clean).filter(Boolean).slice(0, 200);

      if (!text) return res.status(400).json({ error: 'Please type something to log' });
      if (text.length > 500) return res.status(400).json({ error: 'Please keep it under 500 characters' });

      const prompt = `Today is ${today}.
The person's current medications are: ${activeMedications.length ? activeMedications.join(', ') : 'none listed'}.

Turn this message into log entries using the record_log_entries tool:
"${text}"

Rules:
- Only log what the person said. Never invent a dose, date, value, or name.
- One message can contain several entries. Return one entry for each.
- Stopping a medication: if the name matches a current medication, use that exact name.
- Over-the-counter medicines and supplements use medication_kind "otc".
- Family history: the family member goes in family_member, the condition goes in name.
- Sleep: log hours in log_sleep. Exercise: minutes in log_exercise, with the activity if stated. Meals: the plain description in log_meal. Do not estimate calories.
- Removing a condition or allergy ("I'm no longer allergic to penicillin"): use remove_condition or remove_allergy with the name in name.
- Hospitalizations and surgeries: put the reason or surgery name in name, and the date in date.
- Dates: convert to YYYY-MM-DD. If only a month and year are given, use the first of that month.
- If anything is missing or unclear, return an unclear entry with a short question to ask.
- Do not give medical advice.`;

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1500,
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
