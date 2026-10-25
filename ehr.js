// Generic SMART on FHIR connector for EHR systems (Epic, Oracle Health, athenahealth, MEDITECH, ...).
// Systems are defined in ehr-systems.js. A system is usable only once its fhirBase and
// client credentials are set in the environment.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const SYSTEMS = require('./ehr-systems');

const BACKEND_URL = process.env.BACKEND_URL || 'https://easymedical-backend-new-production.up.railway.app';

// File-based token storage (survives container restarts on Railway)
const TOKEN_FILE = path.join('/tmp', 'ehr_tokens.json');
const TOKEN_TTL_MS = 5 * 60 * 1000;

const getTokenStorage = () => {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading token file:', error);
  }
  return {};
};

const saveTokenStorage = (tokens) => {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing token file:', error);
  }
};

// Authorization codes already exchanged, to block replays
const processedCodes = new Set();
// SMART endpoints discovered per system
const discoveryCache = new Map();

const isConfigured = (system) =>
  Boolean(system.fhirBase && process.env[system.clientIdEnv] && process.env[system.clientSecretEnv]);

const callbackPathFor = (system) => system.callbackPath || `/api/ehr/${system.id}/callback`;
const callbackUrlFor = (system) => `${BACKEND_URL}${callbackPathFor(system)}`;

// Use explicit endpoints when given; otherwise read them from the SMART discovery document
async function getEndpoints(system) {
  if (system.authorizeUrl && system.tokenUrl) {
    return { authorizeUrl: system.authorizeUrl, tokenUrl: system.tokenUrl };
  }
  if (!discoveryCache.has(system.id)) {
    const res = await fetch(`${system.fhirBase}/.well-known/smart-configuration`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`SMART discovery failed for ${system.name} (${res.status})`);
    }
    const config = await res.json();
    discoveryCache.set(system.id, {
      authorizeUrl: config.authorization_endpoint,
      tokenUrl: config.token_endpoint,
    });
  }
  return discoveryCache.get(system.id);
}

const htmlPage = (title, message) => `
  <!DOCTYPE html>
  <html>
  <head>
    <title>${title}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
      .container { text-align: center; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
      h1 { color: #007AFF; margin: 0; }
      p { color: #666; margin: 12px 0; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>${title}</h1>
      <p>${message}</p>
      <p>You can close this window and return to the app.</p>
    </div>
  </body>
  </html>
`;

const authorizeHandler = (system) => async (req, res) => {
  if (!isConfigured(system)) {
    return res.status(503).json({ error: `${system.name} is not configured on the server` });
  }
  try {
    const { authorizeUrl } = await getEndpoints(system);
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      client_id: process.env[system.clientIdEnv],
      response_type: 'code',
      redirect_uri: callbackUrlFor(system),
      scope: system.scopes,
      state,
    });

    console.log(`✅ Authorization URL generated for ${system.id} (state ${state.substring(0, 8)}...)`);
    res.json({ url: `${authorizeUrl}?${params.toString()}`, state });
  } catch (error) {
    console.error(`OAuth authorize error (${system.id}):`, error);
    res.status(500).json({ error: `Failed to start ${system.name} authorization` });
  }
};

const callbackHandler = (system) => async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(htmlPage('Authorization cancelled', `${system.name} did not grant access (${error}).`));
    }
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state' });
    }
    if (processedCodes.has(code)) {
      return res.status(200).send(htmlPage('Already authorized', `Your ${system.name} account has already been connected.`));
    }
    processedCodes.add(code);

    const { tokenUrl } = await getEndpoints(system);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrlFor(system),
      client_id: process.env[system.clientIdEnv],
      client_secret: process.env[system.clientSecretEnv],
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const responseText = await tokenResponse.text();

    if (!tokenResponse.ok) {
      console.error(`Token exchange failed (${system.id}, ${tokenResponse.status}):`, responseText);
      return res.status(400).json({ error: 'Failed to exchange code', details: responseText });
    }

    const tokenData = JSON.parse(responseText);

    // Patient ID comes from the token response, or from the id_token's fhirUser claim
    let patientId = tokenData.patient || null;
    if (!patientId && tokenData.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString());
        if (payload.fhirUser) patientId = payload.fhirUser.split('/').pop();
      } catch (e) {
        console.warn(`Could not decode id_token (${system.id}):`, e.message);
      }
    }

    const tokens = getTokenStorage();
    tokens[state] = {
      systemId: system.id,
      token: tokenData.access_token,
      tokenData,
      patientId,
      timestamp: Date.now(),
    };
    saveTokenStorage(tokens);

    console.log(`🔑 ${system.id} granted scope: ${tokenData.scope || '(none reported)'}`);
    console.log(`✅ ${system.id} token stored (patient ${patientId || 'not provided'})`);
    res.status(200).send(htmlPage('Authorization Successful!', `Your ${system.name} account has been connected.`));
  } catch (error) {
    console.error(`Callback error (${system.id}):`, error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

// The app polls this with the state it generated. The token is handed over once.
const tokenHandler = (req, res) => {
  const { state } = req.params;
  const tokens = getTokenStorage();
  const entry = tokens[state];

  if (!entry) {
    return res.status(404).json({ error: 'Token not found or expired' });
  }
  if (Date.now() - entry.timestamp > TOKEN_TTL_MS) {
    delete tokens[state];
    saveTokenStorage(tokens);
    return res.status(410).json({ error: 'Token expired' });
  }

  delete tokens[state];
  saveTokenStorage(tokens);

  const system = SYSTEMS.find((s) => s.id === entry.systemId);
  res.json({
    access_token: entry.token,
    token_type: entry.tokenData.token_type,
    expires_in: entry.tokenData.expires_in,
    scope: entry.tokenData.scope,
    patient: entry.patientId,
    system_id: entry.systemId,
    system_name: system?.name,
    system_label: system?.label || system?.name,
    fhir_base: system?.fhirBase,
  });
};

// Fetches one page of a FHIR search
const getOnePage = async (url, headers) => {
  const res = await fetch(url, { headers });
  if (res.status === 401) {
    const error = new Error('Epic sign-in has expired');
    error.status = 401;
    throw error;
  }
  if (!res.ok) {
    // Epic's reply says why the query was refused. Only the first part is logged.
    const reason = (await res.text().catch(() => '')).slice(0, 300);
    console.warn(`FHIR query failed (${res.status}): ${url.split('?')[0]}${reason ? ` — ${reason}` : ''}`);
    return null;
  }
  const body = await res.json();
  // Some servers answer a non-permitted query with an OperationOutcome instead of a bundle
  if (body.resourceType === 'OperationOutcome') {
    console.warn(`FHIR returned OperationOutcome: ${url.split('?')[0]}`);
    return null;
  }
  return body;
};

// Follows the bundle's "next" link so long result lists aren't cut off after one page
const MAX_PAGES = 20;
const nextLink = (bundle) => bundle?.link?.find((l) => l.relation === 'next')?.url;

const getJson = async (url, headers) => {
  const first = await getOnePage(url, headers);
  if (!first || !Array.isArray(first.entry)) return first;

  let bundle = first;
  let next = nextLink(first);
  let pages = 1;
  while (next && pages < MAX_PAGES) {
    const page = await getOnePage(next, headers);
    if (!page) break;
    bundle = { ...bundle, entry: [...bundle.entry, ...(page.entry || [])] };
    next = nextLink(page);
    pages++;
  }
  if (next) console.warn(`Stopped after ${MAX_PAGES} pages; more results exist for ${url.split('?')[0]}`);
  return { ...bundle, link: [] };
};

const entriesOf = (bundle) =>
  (bundle?.entry || []).map((e) => e.resource).filter((r) => r && r.resourceType !== 'OperationOutcome');

const codeText = (resource) => resource.code?.text || resource.code?.coding?.[0]?.display || 'Unknown';

// Epic links each document to its text through an attachment URL (a Binary resource). This fetches the text,
// preferring HTML and then plain text. Documents without a readable text link are returned without noteText.
const withNoteText = async (documents, accessToken) =>
  Promise.all(
    documents.map(async (doc) => {
      const attachments = (doc.content || []).map((c) => c.attachment).filter((a) => a && a.url);
      const attachment =
        attachments.find((a) => a.contentType === 'text/html') || attachments.find((a) => a.contentType === 'text/plain');
      if (!attachment) return doc;
      try {
        const res = await fetch(attachment.url, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: attachment.contentType },
        });
        if (!res.ok) {
          console.warn(`📄 note text failed (${res.status})`);
          return doc;
        }
        return { ...doc, noteText: await res.text(), noteContentType: attachment.contentType };
      } catch (error) {
        console.warn(`📄 note text error: ${error.message}`);
        return doc;
      }
    })
  );

// A procedure only counts if Epic gave it a name or a date. Otherwise it's an empty placeholder.
const isRealProcedure = (r) =>
  codeText(r) !== 'Unknown' || Boolean(r.performedDateTime || r.performedPeriod?.start || r.performedDate);

async function fetchPatientBundle(system, accessToken, patientId) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' };
  const query = (resourcePath) =>
    getJson(`${system.fhirBase}${resourcePath}`, headers).catch((error) => {
      if (error.status === 401) throw error;
      console.warn(`⚠️ ${resourcePath.split('?')[0]} failed: ${error.status || ''} ${String(error.message || error).slice(0, 300)}`);
      return null;
    });

  const [patient, meds, labs, vitals, procedures, diagnostics, conditions, allergies, immunizations, documents] = await Promise.all([
    query(`/Patient/${patientId}`),
    // All medication orders, including stopped and completed ones, so past medications come through
    query(`/MedicationRequest?patient=${patientId}&_count=100`),
    query(`/Observation?patient=${patientId}&category=laboratory&_count=100`),
    query(`/Observation?patient=${patientId}&category=vital-signs&_count=100`),
    query(`/Procedure?patient=${patientId}&_count=100`),
    query(`/DiagnosticReport?patient=${patientId}&_count=100`),
    query(`/Condition?patient=${patientId}&_count=100`),
    query(`/AllergyIntolerance?patient=${patientId}&_count=100`),
    query(`/Immunization?patient=${patientId}&_count=100`),
    // Clinical notes and other documents. Filtered to notes in the app, once Epic's responses are checked.
    query(`/DocumentReference?patient=${patientId}&_count=100`),
  ]);

  // Debug: what Epic returned for documents. Codes and flags only, no note text.
  const documentEntries = documents?.entry || [];
  console.log(`📄 documents for ${patientId}: ${documents ? documentEntries.length : 'request failed'} entries`);
  documentEntries.slice(0, 5).forEach((e, i) => {
    const r = e.resource || {};
    console.log(`📄 document ${i + 1}: ${JSON.stringify({
      type: r.type?.coding?.map((c) => c.code),
      category: r.category?.map((c) => c.coding?.map((x) => x.code)),
      content: (r.content || []).map((c) => ({
        contentType: c.attachment?.contentType,
        inlineData: !!c.attachment?.data,
        hasUrl: !!c.attachment?.url,
      })),
    })}`);
  });

  // Debug: what Epic returned for vital signs, so readings that get dropped can be found
  const vitalEntries = vitals?.entry || [];
  console.log(`🩺 vital-signs for ${patientId}: ${vitals ? vitalEntries.length : 'request failed'} entries`);
  if (vitalEntries.length > 0) {
    vitalEntries.slice(0, 3).forEach((e, i) => console.log(`🩺 vital ${i + 1}: ${JSON.stringify(e.resource).slice(0, 1200)}`));
  }

  // Normal range as the server sent it (FHIR Observation.referenceRange)
  const referenceRangeOf = (r) => {
    const range = r.referenceRange?.[0];
    if (!range) return '';
    if (range.text) return range.text;
    const low = range.low?.value;
    const high = range.high?.value;
    const unit = range.low?.unit || range.high?.unit || '';
    if (low != null && high != null) return `${low}-${high} ${unit}`.trim();
    if (high != null) return `<${high} ${unit}`.trim();
    if (low != null) return `>${low} ${unit}`.trim();
    return '';
  };

  // Only keep observations that have both a value and a date, so nothing gets stamped with the sync date
  // Blood pressure is one observation with systolic and diastolic components (LOINC 8480-6 and 8462-4)
  const componentValue = (r, loincCode) => {
    const component = (r.component || []).find((c) => (c.code?.coding || []).some((cd) => cd.code === loincCode));
    return component?.valueQuantity?.value;
  };

  const observations = [...entriesOf(labs), ...entriesOf(vitals)]
    .map((r) => {
      const systolic = componentValue(r, '8480-6');
      const diastolic = componentValue(r, '8462-4');
      if (systolic != null && diastolic != null) {
        return {
          id: r.id,
          code: 'Blood Pressure',
          value: `${systolic}/${diastolic}`,
          unit: 'mmHg',
          systolic,
          diastolic,
          referenceRange: '',
          date: r.effectiveDateTime || r.effectiveDate || '',
        };
      }
      return {
        id: r.id,
        code: codeText(r),
        value: r.valueQuantity?.value ?? r.valueString ?? '',
        unit: r.valueQuantity?.unit || '',
        referenceRange: referenceRangeOf(r),
        date: r.effectiveDateTime || r.effectiveDate || '',
      };
    })
    .filter((o) => o.value !== '' && o.date);

  return {
    patient,
    medications: entriesOf(meds),
    immunizations: entriesOf(immunizations),
    documents: await withNoteText(entriesOf(documents), accessToken),
    observations,
    procedures: entriesOf(procedures).filter(isRealProcedure),
    diagnostics: entriesOf(diagnostics),
    conditions: entriesOf(conditions).map((r) => ({
      id: r.id,
      name: codeText(r),
      onsetDate: r.onsetDateTime || '',
      status: r.clinicalStatus?.coding?.[0]?.code || r.verificationStatus?.coding?.[0]?.code || 'unknown',
    })),
    allergies: entriesOf(allergies).map((r) => ({
      id: r.id,
      allergen: codeText(r),
      reaction: r.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display || r.reaction?.[0]?.manifestation?.[0]?.text || 'Reaction',
      criticality: r.criticality || 'unknown',
    })),
  };
}

const patientDataHandler = (system) => async (req, res) => {
  if (!isConfigured(system)) {
    return res.status(503).json({ error: `${system.name} is not configured on the server` });
  }
  // A patient ID is required. Unfiltered queries would return other patients' records.
  const { accessToken, patientId } = req.body || {};
  if (!accessToken || !patientId) {
    return res.status(400).json({ error: 'accessToken and patientId are required' });
  }
  try {
    res.json(await fetchPatientBundle(system, accessToken, patientId));
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({ error: 'Epic sign-in has expired. Reconnect Epic in Settings.', expired: true });
    }
    console.error(`Patient data error (${system.id}):`, error);
    res.status(500).json({ error: 'Failed to fetch patient data' });
  }
};

function mountEhrRoutes(app) {
  // Systems the app can offer; `configured` says whether the server can actually use them
  app.get('/api/ehr/systems', (req, res) => {
    res.json(SYSTEMS.map((s) => ({ id: s.id, name: s.name, label: s.label || s.name, configured: isConfigured(s) })));
  });

  app.get(['/api/ehr/token/:state', '/api/auth/epic/token/:state'], tokenHandler);

  SYSTEMS.forEach((system) => {
    const authorize = authorizeHandler(system);
    const patientData = patientDataHandler(system);

    app.get(`/api/ehr/${system.id}/authorize`, authorize);
    app.get(callbackPathFor(system), callbackHandler(system));
    app.post(`/api/ehr/${system.id}/patient-data`, patientData);

    if (system.legacyPrefix) {
      app.get(`${system.legacyPrefix}/authorize`, authorize);
      app.post(`${system.legacyPrefix}/patient-data`, patientData);
    }
  });
}

module.exports = { mountEhrRoutes };
