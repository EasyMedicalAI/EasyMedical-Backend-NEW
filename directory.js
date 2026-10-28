// Anthem provider directory. Looks up doctors and facilities by specialty and ZIP code.
// The client ID, secret, token URL, and directory URL come from Railway variables, never from the code.
// Only the Practitioner and Organization details the app needs are returned.

let cachedToken = null;

const configured = () =>
  Boolean(
    process.env.ANTHEM_CLIENT_ID &&
      process.env.ANTHEM_CLIENT_SECRET &&
      process.env.ANTHEM_TOKEN_URL &&
      process.env.ANTHEM_DIRECTORY_URL
  );

// Names the first URL variable that isn't a valid https address. Only the variable name is returned, never its value.
const badUrlVariable = () =>
  ['ANTHEM_TOKEN_URL', 'ANTHEM_DIRECTORY_URL'].find((name) => {
    try {
      return new URL(process.env[name]).protocol !== 'https:';
    } catch {
      return true;
    }
  });

// Gets an access token with the client credentials grant. The token is reused until shortly before it expires.
async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.ANTHEM_CLIENT_ID,
    client_secret: process.env.ANTHEM_CLIENT_SECRET,
  });
  const res = await fetch(process.env.ANTHEM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  }).catch((error) => {
    console.warn(`Anthem sign-in could not connect: ${error.cause?.code || error.message}`);
    throw Object.assign(new Error('Could not reach Anthem sign-in'), { status: 502 });
  });
  if (!res.ok) {
    // Logs the status only, never the response body or the credentials
    console.warn(`Anthem token request failed (${res.status})`);
    throw Object.assign(new Error('Anthem sign-in failed'), { status: 502 });
  }
  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 300) * 1000,
  };
  return cachedToken.value;
}

// Searches the directory for practitioners with a specialty near a ZIP code
// GET one FHIR search URL from the Anthem directory. Logs the status and the start of Anthem's reply, never the credentials.
async function directoryGet(path, token) {
  const url = `${process.env.ANTHEM_DIRECTORY_URL}/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' } }).catch(
    (error) => {
      console.warn(`Anthem directory could not connect: ${error.cause?.code || error.message}`);
      throw Object.assign(new Error('Could not reach the Anthem directory'), { status: 502 });
    }
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    console.warn(`Anthem directory search failed (${res.status}) ${path.split('?')[0]}: ${detail}`);
    throw Object.assign(new Error('Anthem directory search failed'), { status: 502 });
  }
  return res.json();
}

// Doctors near a ZIP code: find the locations in the ZIP, then the practitioner roles at those locations.
// The directory doesn't accept a ZIP on PractitionerRole, so the ZIP is searched on Location first.
// The specialty is matched against the names the directory returns, since it doesn't take a plain-text specialty.
async function searchDirectory({ specialty, zip }) {
  const token = await getToken();

  const locations = await directoryGet(`Location?address-postalcode=${encodeURIComponent(zip)}&_count=100`, token);
  const locationIds = (locations.entry || []).map((e) => e.resource?.id).filter(Boolean);
  if (locationIds.length === 0) return [];

  const locationParam = locationIds.map((id) => `Location/${id}`).join(',');
  const roles = await directoryGet(`PractitionerRole?location=${encodeURIComponent(locationParam)}&_count=50`, token);
  const wanted = specialty ? specialty.toLowerCase() : '';

  return (roles.entry || [])
    .map((e) => e.resource)
    .filter(Boolean)
    .map((role) => ({
      id: role.id,
      name: role.practitioner?.display || role.organization?.display || 'Unknown',
      specialty: role.specialty?.[0]?.coding?.[0]?.display || role.specialty?.[0]?.text || '',
      phone: (role.telecom || []).find((t) => t.system === 'phone')?.value || '',
    }))
    .filter((role) => !wanted || role.specialty.toLowerCase().includes(wanted));
}

function mountDirectoryRoutes(app) {
  // GET /api/directory/anthem/search?specialty=Cardiology&zip=08108
  app.get('/api/directory/anthem/search', async (req, res) => {
    if (!configured()) {
      return res.status(503).json({ error: 'Anthem directory is not configured on the server' });
    }
    const badUrl = badUrlVariable();
    if (badUrl) {
      return res.status(503).json({ error: `${badUrl} is not a valid https address. Check the value in Railway.` });
    }
    const { specialty, zip } = req.query;
    if (!zip || !/^\d{5}$/.test(String(zip))) {
      return res.status(400).json({ error: 'A 5-digit ZIP code is required' });
    }
    try {
      res.json({ results: await searchDirectory({ specialty: specialty ? String(specialty) : '', zip: String(zip) }) });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { mountDirectoryRoutes };
