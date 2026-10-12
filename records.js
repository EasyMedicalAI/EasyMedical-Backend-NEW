// Structured extraction for uploaded medical documents.
// Every upload, whatever the document (lab report, visit note, medication label, discharge
// paperwork, ...), comes back in the same shape, so the app can show all of them the same way.

const DOCUMENT_TYPES = [
  'lab_report',
  'visit_note',
  'discharge_summary',
  'medication_label',
  'imaging_report',
  'procedure_report',
  'vaccine_record',
  'insurance',
  'other',
];

// Forced tool call: Claude must answer with this schema, so the output shape never varies.
const EXTRACTION_TOOL = {
  name: 'record_extraction',
  description:
    'Record the structured contents of a medical document. Use empty strings or empty arrays for anything the document does not contain. Never invent values.',
  input_schema: {
    type: 'object',
    properties: {
      document_type: { type: 'string', enum: DOCUMENT_TYPES },
      specialty: {
        type: 'string',
        description: 'One of: Primary Care, Cardiology, Dermatology, Orthopedics, Neurology, OBGYN, Psychiatry, Ophthalmology, ENT, Gastroenterology, Pulmonology, Rheumatology, Endocrinology, Urology, Oncology, Lab, Imaging, Dentistry, Surgical, Pharmacy, Other',
      },
      date: { type: 'string', description: 'Date of service or specimen collection as YYYY-MM-DD, or empty string' },
      provider: { type: 'string', description: 'Doctor, clinician or lab name, or empty string' },
      facility: { type: 'string', description: 'Clinic, hospital or lab name, or empty string' },
      reason: { type: 'string', description: 'Why the visit or test happened, in 3 to 8 words' },
      summary: {
        type: 'string',
        description: 'Two or three plain-language sentences a patient can understand. No jargon, no abbreviations left unexplained.',
      },
      key_findings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short plain-language findings, one per item',
      },
      lab_results: {
        type: 'array',
        description: 'Every individual lab test in the document, one item per test',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
            unit: { type: 'string' },
            reference_range: { type: 'string' },
            flag: { type: 'string', enum: ['normal', 'high', 'low', 'abnormal', 'unknown'] },
          },
          required: ['name', 'value', 'flag'],
        },
      },
      medications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            dose: { type: 'string' },
            instructions: { type: 'string' },
          },
          required: ['name'],
        },
      },
      diagnoses: { type: 'array', items: { type: 'string' } },
      next_steps: { type: 'array', items: { type: 'string' }, description: 'Follow-up actions the document asks for' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Lower this if pages were blurry or cut off' },
    },
    required: [
      'document_type',
      'specialty',
      'date',
      'provider',
      'reason',
      'summary',
      'key_findings',
      'lab_results',
      'medications',
      'diagnoses',
      'next_steps',
      'confidence',
    ],
  },
};

const PROMPT = `Read every page image and extract the document into the record_extraction tool.

Rules:
- Use every page. If there are several pages, treat them as one document.
- Lab reports: include EVERY test row with its value, unit, reference range and flag. Use the report's own H/L markers for the flag. If there is no marker, compare the value to the reference range. Use "unknown" only if neither works.
- Dates: convert to YYYY-MM-DD.
- Medication labels: put the drug name, strength in dose, and directions in instructions.
- Keep the summary in plain language a patient understands.
- Never invent a value. Leave a field empty if the document does not contain it.
- If the images are unreadable or cut off, say so in the summary and set confidence to low.`;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const cleanList = (list) => (Array.isArray(list) ? list.map(clean).filter(Boolean) : []);

const FLAGS = ['normal', 'high', 'low', 'abnormal', 'unknown'];

// Accepts YYYY-MM-DD or MM/DD/YYYY (or M/D/YY) and returns YYYY-MM-DD, or '' when unusable
function normalizeDate(value) {
  const text = clean(value);
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      m = [m[0], year, m[1], m[2]];
    }
  }
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Turn the tool output into the camelCase shape the app uses, with safe defaults
function normalizeExtraction(raw) {
  return {
    documentType: DOCUMENT_TYPES.includes(raw.document_type) ? raw.document_type : 'other',
    specialty: clean(raw.specialty) || 'Other',
    date: normalizeDate(raw.date),
    provider: clean(raw.provider),
    facility: clean(raw.facility),
    reason: clean(raw.reason),
    summary: clean(raw.summary),
    keyFindings: cleanList(raw.key_findings),
    labResults: (Array.isArray(raw.lab_results) ? raw.lab_results : [])
      .map((lab) => ({
        name: clean(lab.name),
        value: clean(lab.value),
        unit: clean(lab.unit),
        referenceRange: clean(lab.reference_range),
        flag: FLAGS.includes(clean(lab.flag).toLowerCase()) ? clean(lab.flag).toLowerCase() : 'unknown',
      }))
      .filter((lab) => lab.name && lab.value),
    medications: (Array.isArray(raw.medications) ? raw.medications : [])
      .map((med) => ({ name: clean(med.name), dose: clean(med.dose), instructions: clean(med.instructions) }))
      .filter((med) => med.name),
    diagnoses: cleanList(raw.diagnoses),
    nextSteps: cleanList(raw.next_steps),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
  };
}

function mountRecordRoutes(app, client) {
  app.post('/api/vision/extract-record', async (req, res) => {
    try {
      const { images } = req.body || {};
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
        max_tokens: 3000,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
        messages: [{ role: 'user', content }],
      });

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse) {
        return res.status(502).json({ error: 'No structured result returned' });
      }

      res.json(normalizeExtraction(toolUse.input));
    } catch (error) {
      console.error('Record extraction error:', error);
      res.status(500).json({ error: error.message || 'Extraction failed' });
    }
  });
}

module.exports = { mountRecordRoutes, normalizeExtraction };
