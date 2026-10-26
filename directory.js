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
async function searchDirectory({ specialty, zip }) {
  const token = await getToken();
  const params = new URLSearchParams({ _count: '50' });
  if (specialty) params.set('specialty', specialty);
  if (zip) params.set('address-postalcode', zip);

  const url = `${process.env.ANTHEM_DIRECTORY_URL}/PractitionerRole?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' } });
  if (!res.ok) {
    console.warn(`Anthem directory search failed (${res.status})`);
    throw Object.assign(new Error('Anthem directory search failed'), { status: 502 });
  }
  const bundle = await res.json();
  return (bundle.entry || [])
    .map((e) => e.resource)
    .filter(Boolean)
    .map((role) => ({
      id: role.id,
      name: role.practitioner?.display || role.organization?.display || 'Unknown',
      specialty: role.specialty?.[0]?.coding?.[0]?.display || role.specialty?.[0]?.text || '',
      phone: (role.telecom || []).find((t) => t.system === 'phone')?.value || '',
    }));
}

function mountDirectoryRoutes(app) {
  // GET /api/directory/anthem/search?specialty=Cardiology&zip=08108
  app.get('/api/directory/anthem/search', async (req, res) => {
    if (!configured()) {
      return res.status(503).json({ error: 'Anthem directory is not configured on the server' });
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
