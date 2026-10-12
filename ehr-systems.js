// EHR systems EasyMedical can connect to.
//
// Each entry is one SMART on FHIR (R4) endpoint. Usually that means one entry per
// health system, because a hospital's Epic or Oracle Health instance has its own
// FHIR base URL. Client IDs and secrets are read from the environment variables
// named below, so secrets never live in this file or in the app bundle.
//
// To connect a new health system:
//   1. Get its FHIR base URL and a client registration from the vendor.
//   2. Register the redirect URI `${BACKEND_URL}${callbackPath}` with that vendor.
//   3. Set the fhirBase / client env vars on Railway and redeploy.
// The app lists a system only when its fhirBase and both credentials are set.

const EPIC_SCOPES =
  'openid fhirUser patient/Patient.read patient/Medication.read patient/Observation.read ' +
  'patient/Procedure.read patient/DiagnosticReport.read patient/AllergyIntolerance.read ' +
  'patient/Condition.read patient/Appointment.read patient/Immunization.read';

// Other vendors may need different scope names once registered. Adjust per system.
const DEFAULT_SCOPES = EPIC_SCOPES;

module.exports = [
  {
    id: 'epic',
    name: 'Epic (MyChart)',
    label: 'Epic EHR', // prefix used on imported records
    fhirBase: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
    // Explicit endpoints. Leave authorizeUrl/tokenUrl out to use SMART discovery instead.
    authorizeUrl: 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize',
    tokenUrl: 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token',
    clientIdEnv: 'EPIC_CLIENT_ID',
    clientSecretEnv: 'EPIC_CLIENT_SECRET',
    // Already registered with Epic, so this path must not change.
    callbackPath: '/api/auth/epic/callback',
    // Older app builds call these paths, so they stay available.
    legacyPrefix: '/api/auth/epic',
    scopes: EPIC_SCOPES,
  },
  {
    id: 'oracle',
    name: 'Oracle Health (Cerner)',
    label: 'Oracle Health',
    fhirBase: process.env.ORACLE_FHIR_BASE, // one per health system
    clientIdEnv: 'ORACLE_CLIENT_ID',
    clientSecretEnv: 'ORACLE_CLIENT_SECRET',
    scopes: DEFAULT_SCOPES,
  },
  {
    id: 'athena',
    name: 'athenahealth',
    label: 'athenahealth',
    fhirBase: process.env.ATHENA_FHIR_BASE,
    clientIdEnv: 'ATHENA_CLIENT_ID',
    clientSecretEnv: 'ATHENA_CLIENT_SECRET',
    scopes: DEFAULT_SCOPES,
  },
  {
    id: 'meditech',
    name: 'MEDITECH Expanse',
    label: 'MEDITECH',
    fhirBase: process.env.MEDITECH_FHIR_BASE,
    clientIdEnv: 'MEDITECH_CLIENT_ID',
    clientSecretEnv: 'MEDITECH_CLIENT_SECRET',
    scopes: DEFAULT_SCOPES,
  },
];
