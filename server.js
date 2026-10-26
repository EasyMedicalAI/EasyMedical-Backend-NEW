const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Increase payload limit for image uploads (default is 100KB, we need 50MB+)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const { mountEhrRoutes } = require('./ehr');
const { mountRecordRoutes } = require('./records');
const { mountMedicationRoutes } = require('./medications');
const { mountInsuranceRoutes } = require('./insurance');
const { mountAssistantRoutes } = require('./assistant');
const { mountDirectoryRoutes } = require('./directory');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Structured extraction: every uploaded document comes back in one shape
mountRecordRoutes(app, client);
mountMedicationRoutes(app, client);
mountInsuranceRoutes(app, client);
mountDirectoryRoutes(app);

// Turns typed or dictated health notes into entries the person confirms before saving
mountAssistantRoutes(app, client);

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, hasMedicalContext } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    let systemPrompt = 'You are a health education assistant. Provide concise, clear health information (2-3 sentences max). Use plain text only - no markdown formatting, no #, **, -, or bullet points. Be helpful but remind users this is educational information only and not a substitute for professional medical advice.';

    // If medical context is provided, use a more personalized prompt
    if (hasMedicalContext) {
      systemPrompt = 'You are a health education assistant with access to the patient\'s medical records. Answer questions by referencing their specific records when relevant. Provide concise, clear health information (2-3 sentences max). Use plain text only - no markdown formatting, no #, **, -, or bullet points. Be helpful but remind users this is educational information only and not a substitute for professional medical advice. Always encourage the patient to discuss findings with their healthcare provider.';
    }

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages,
    });

    const assistantMessage = response.content[0];
    if (assistantMessage.type !== 'text') {
      return res.status(500).json({ error: 'Unexpected response type' });
    }

    res.json({ content: assistantMessage.text, usage: response.usage });
  } catch (error) {
    console.error('Chatbot error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// EHR connectors (Epic, Oracle Health, ...) live in ehr.js
mountEhrRoutes(app);

// Vision analysis endpoints
app.post('/api/vision/analyze-medication', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image is required' });
    }

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: image,
              },
            },
            {
              type: 'text',
              text: 'Please analyze this medication bottle and extract the following information in JSON format: { "name": "medication name", "dosage": "dosage amount", "frequency": "how often to take", "directions": "directions for use", "warnings": "any warnings or side effects noted" }. Be precise and only include information visible on the label.',
            },
          ],
        },
      ],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return res.status(500).json({ error: 'Unexpected response type' });
    }

    // Try to parse JSON from response
    let analysisData;
    try {
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      analysisData = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: textContent.text };
    } catch {
      analysisData = { raw: textContent.text };
    }

    res.json({
      success: true,
      analysis: analysisData,
      rawResponse: textContent.text,
    });
  } catch (error) {
    console.error('Medication analysis error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.post('/api/vision/analyze-document', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image is required' });
    }

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: image,
              },
            },
            {
              type: 'text',
              text: 'Please analyze this medical document and extract key information. Provide a structured summary including: type of document (prescription, test result, lab report, etc.), date, key findings/medications, and any important notes or results.',
            },
          ],
        },
      ],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return res.status(500).json({ error: 'Unexpected response type' });
    }

    res.json({
      success: true,
      analysis: textContent.text,
    });
  } catch (error) {
    console.error('Document analysis error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.post('/api/vision/analyze-record', async (req, res) => {
  try {
    const { images, recordType } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' });
    }

    const isLab = recordType === 'lab';

    // Build content array with all images
    const content = [];
    images.forEach((image) => {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: image,
        },
      });
    });

    // Add different prompts based on record type
    let prompt;
    if (isLab) {
      prompt = `CRITICAL: Extract EVERY SINGLE lab test from this LabCorp report. There are typically 14+ tests in the CMP and 5+ in the Lipid Panel. DO NOT STOP until you've found them all.

Step 1: Find and extract the DATE COLLECTED
Step 2: Extract EVERY test from the Comp. Metabolic Panel table (look for rows with: Glucose, BUN, Creatinine, eGFR, Sodium, Potassium, Chloride, Calcium, Protein, Albumin, Globulin, Bilirubin, Phosphatase, AST, ALT, etc.)
Step 3: Extract EVERY test from the Lipid Panel table (look for: Cholesterol, Triglycerides, HDL, VLDL, LDL)
Step 4: Verify you found at least 14 CMP tests and 5 Lipid Panel tests (20+ total)

OUTPUT FORMAT:
Date Collected: MM/DD/YYYY
TEST_COUNT: XX (e.g., "TEST_COUNT: 22")
Glucose: 98 (70-99)
BUN: 18 (6-20)
Creatinine: 0.98 (0.76-1.27)
eGFR: 106 (>59)
BUN/Creatinine Ratio: 18 (9-20)
Sodium: 141 (134-144)
Potassium: 4.8 (3.5-5.2)
Chloride: 104 (96-106)
Carbon Dioxide, Total: 23 (20-29)
Calcium: 10.0 (8.7-10.2)
Protein, Total: 7.0 (6.0-8.5)
Albumin: 4.7 (4.3-5.2)
Globulin, Total: 2.3 (1.5-4.5)
Bilirubin, Total: 0.3 (0.0-1.2)
Alkaline Phosphatase: 57 (44-121)
AST (SGOT): 29 (0-40)
ALT (SGPT): 35 (0-44)
Cholesterol, Total: 215 (100-199)
Triglycerides: 104 (0-149)
HDL Cholesterol: 55 (>39)
VLDL Cholesterol: 18 (5-40)
LDL Chol Calc (NIH): 142 (0-99)

MUST HAVES:
- Always start with Date Collected
- Always include TEST_COUNT showing total tests extracted
- READ EVERY TABLE ROW COMPLETELY
- Do not stop after CMP - continue to Lipid Panel
- For each test: Name: Value (Reference Range)
- Reference ranges from the "Reference Interval" column
- Return at least 20 total tests
- If you find fewer than 15 tests, re-read the entire image again before responding`;
    } else {
      prompt = `CRITICAL: Extract EXACTLY this information from the medical record:

1. APPOINTMENT DATE: The date when the appointment/visit happened (MM/DD/YYYY format)
2. DOCTOR: The doctor's or provider's full name
3. REASON: Summarize the visit reason in exactly 3 words
4. SUMMARY: One paragraph summary of the visit/findings

Return in this EXACT format:
APPOINTMENT DATE: MM/DD/YYYY
DOCTOR: [name]
REASON: [3 words]
SUMMARY: [paragraph]
KEY POINTS: [list]

EXAMPLE:
APPOINTMENT DATE: 01/15/2026
DOCTOR: Dr. John Smith
REASON: Established patient visit
SUMMARY: 45-year-old male came for routine check-up. Vital signs normal. Patient reports no acute complaints.
KEY POINTS:
- Blood pressure: 120/80 (normal)
- Weight: stable
- No new medical concerns

Make sure to find and include the appointment date from the document header or top of the record.`;
    }

    content.push({
      type: 'text',
      text: prompt,
    });

    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: isLab ? 1000 : 500,
      messages: [
        {
          role: 'user',
          content: content,
        },
      ],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return res.status(500).json({ error: 'Unexpected response type' });
    }

    res.json({
      success: true,
      analysis: textContent.text,
      recordType: recordType,
    });
  } catch (error) {
    console.error('Record analysis error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});


// Health check
app.get('/', (req, res) => {
  res.json({ message: 'EasyMedical Backend API', routes: ['/api/chat', '/api/ehr/systems', '/api/ehr/:system/authorize', '/api/ehr/:system/patient-data', '/api/vision/analyze-medication', '/api/vision/analyze-document', '/api/vision/analyze-record'] });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
