// Reads a medication label from a photo: name, dose, how often, and reminder times.
// Only what is printed on the label is used. Anything missing is left empty for the person to fill in.

const LABEL_TOOL = {
  name: 'medication_label',
  description: 'Record what is printed on a medication label. Leave a field empty if the label does not show it.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The medication name, as printed' },
      dose: { type: 'string', description: 'The strength or amount per dose, such as "50 mg" or "1 tablet"' },
      how_often: { type: 'string', description: 'How often to take it, such as "Once daily" or "Every 8 hours"' },
      times_per_day: { type: 'integer', description: 'How many doses a day the label asks for, 0 if unknown' },
      reminder_times: {
        type: 'array',
        items: { type: 'string' },
        description: 'Times of day the label names, in 24-hour HH:MM form, such as "21:00" for bedtime. Empty if none are named.',
      },
      instructions: { type: 'string', description: 'Directions for use, such as "with food"' },
      is_otc: { type: 'boolean', description: 'True if the label is for an over-the-counter product' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string', description: 'Anything unclear or hard to read' },
    },
    required: ['name', 'dose', 'how_often', 'times_per_day', 'reminder_times', 'instructions', 'is_otc', 'confidence', 'notes'],
  },
};

const PROMPT = `Read the medication label in the image(s) and record it with the medication_label tool.
- Only use what is printed on the label. Do not guess a dose or a name.
- If a field is not on the label, leave it empty (or 0 for times_per_day).
- Put any part you could not read clearly in notes, and set confidence to low.`;

// Keeps only what the app can use
function normalizeLabel(raw) {
  const times = Array.isArray(raw.reminder_times)
    ? raw.reminder_times.filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t.trim())).map((t) => t.trim())
    : [];
  return {
    name: String(raw.name || '').trim(),
    dose: String(raw.dose || '').trim(),
    howOften: String(raw.how_often || '').trim(),
    timesPerDay: Math.min(4, Math.max(0, parseInt(raw.times_per_day, 10) || 0)),
    reminderTimes: times,
    instructions: String(raw.instructions || '').trim(),
    isOtc: raw.is_otc === true,
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
    notes: String(raw.notes || '').trim(),
  };
}

function mountMedicationRoutes(app, client) {
  app.post('/api/vision/medication-label', async (req, res) => {
    try {
      const { images = [] } = req.body || {};
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'At least one image is required' });
      }

      const content = images.map((data) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
      }));
      content.push({ type: 'text', text: PROMPT });

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1500,
        tools: [LABEL_TOOL],
        tool_choice: { type: 'tool', name: LABEL_TOOL.name },
        messages: [{ role: 'user', content }],
      });

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse) {
        return res.status(502).json({ error: 'No result returned for the label' });
      }
      res.json(normalizeLabel(toolUse.input));
    } catch (error) {
      console.error('Medication label error:', error);
      res.status(500).json({ error: error.message || 'Label reading failed' });
    }
  });
}

module.exports = { mountMedicationRoutes, normalizeLabel };
