// Reads an insurance card from a photo or PDF: insurer, plan, member ID, group number, and the phone number printed on the card.
// Only what is printed on the card is used. Card images are read and not stored or logged.

const CARD_TOOL = {
  name: 'insurance_card',
  description: 'Record what is printed on an insurance card. Leave a field empty if the card does not show it.',
  input_schema: {
    type: 'object',
    properties: {
      insurer: { type: 'string', description: 'The insurance company name, as printed, such as "Aetna" or "Blue Cross Blue Shield"' },
      plan_name: { type: 'string', description: 'The plan name printed on the card, such as "PPO" or "Choice Plus"' },
      member_id: { type: 'string', description: 'The member or subscriber ID, exactly as printed' },
      group_number: { type: 'string', description: 'The group number, exactly as printed' },
      payer_phone: { type: 'string', description: 'The customer service phone number printed on the card' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string', description: 'Anything unclear or hard to read' },
    },
    required: ['insurer', 'plan_name', 'member_id', 'group_number', 'payer_phone', 'confidence', 'notes'],
  },
};

const PROMPT = `Read the insurance card in the image(s) or document and record it with the insurance_card tool.
- Only use what is printed on the card. Do not guess an ID, a number or a name.
- If a field is not on the card, leave it empty.
- Put any part you could not read clearly in notes, and set confidence to low.`;

// Keeps only what the app can use, with digits and letters as printed
function normalizeCard(raw) {
  return {
    insurer: String(raw.insurer || '').trim(),
    planName: String(raw.plan_name || '').trim(),
    memberId: String(raw.member_id || '').replace(/\s+/g, '').trim(),
    groupNumber: String(raw.group_number || '').replace(/\s+/g, '').trim(),
    payerPhone: String(raw.payer_phone || '').trim(),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
    notes: String(raw.notes || '').trim(),
  };
}

function mountInsuranceRoutes(app, client) {
  app.post('/api/vision/insurance-card', async (req, res) => {
    try {
      const { images = [], documents = [] } = req.body || {};
      if ((!Array.isArray(images) || images.length === 0) && (!Array.isArray(documents) || documents.length === 0)) {
        return res.status(400).json({ error: 'A photo or PDF of the card is required' });
      }

      const content = [
        ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
        ...documents.map((data) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })),
        { type: 'text', text: PROMPT },
      ];

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1000,
        tools: [CARD_TOOL],
        tool_choice: { type: 'tool', name: CARD_TOOL.name },
        messages: [{ role: 'user', content }],
      });

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse) {
        return res.status(502).json({ error: 'No result returned for the card' });
      }
      res.json(normalizeCard(toolUse.input));
    } catch (error) {
      // Logs the error only, never the card itself
      console.error('Insurance card error:', error.message);
      res.status(500).json({ error: error.message || 'Card reading failed' });
    }
  });
}

module.exports = { mountInsuranceRoutes, normalizeCard };
