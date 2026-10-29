// Cost Plus Drugs cash prices for one medication, from Cost Plus's price list search.
// Only the medication name and strength are sent. No ZIP code and no personal details.
const CPD_SEARCH_URL = 'https://api.costplusdrugs.com/pricelist/cpd/search';
// Insurance pricing isn't used, so it isn't requested
const EXCLUDED_FIELDS = [
  'cpd_channel.insurance_dispensing_fee',
  'cpd_channel.insurance_shipping_cost',
  'cpd_channel.insurance_expedited_shipping_cost',
].join(',');

// Cost Plus products for the RxNorm product code, with cash prices per unit and fees
async function searchCostPlus({ term, strength, rxcui }) {
  const params = new URLSearchParams({ term, strength, exclude_fields: EXCLUDED_FIELDS });
  const res = await fetch(`${CPD_SEARCH_URL}?${params.toString()}`, { headers: { Accept: 'application/json' } }).catch(
    (error) => {
      console.warn(`Cost Plus could not connect: ${error.cause?.code || error.message}`);
      throw Object.assign(new Error('Could not reach Cost Plus Drugs'), { status: 502 });
    }
  );
  if (!res.ok) {
    console.warn(`Cost Plus search failed (${res.status})`);
    throw Object.assign(new Error('Cost Plus Drugs search failed'), { status: 502 });
  }
  const entries = await res.json();
  // Cost Plus matches by name, so only the products with this RxNorm code are kept
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => String(entry.rxnorm_id) === String(rxcui))
    .map((entry) => {
      const channel = entry.cpd_channel || {};
      return {
        name: entry.medication_name,
        form: entry.form,
        strength: entry.strength,
        packSize: entry.pack_size,
        unit: entry.unit,
        pricePerUnit: channel.price_per_unit,
        dispensingFee: channel.cash_dispensing_fee,
        shippingCost: channel.cash_shipping_cost ?? null,
        inStock: channel.in_stock,
        url: entry.url,
      };
    });
}

function mountCostPlusRoutes(app) {
  // GET /api/prices/costplus?rxcui=617310&term=atorvastatin&strength=20mg
  app.get('/api/prices/costplus', async (req, res) => {
    const { rxcui, term, strength } = req.query;
    if (!rxcui || !/^\d+$/.test(String(rxcui))) {
      return res.status(400).json({ error: 'An RxNorm product code is required' });
    }
    if (!term || String(term).length > 100) {
      return res.status(400).json({ error: 'A medication name is required' });
    }
    if (!strength || !/^\d+(\.\d+)?\s?(mg|mcg|g|ml)$/i.test(String(strength))) {
      return res.status(400).json({ error: 'A strength such as 20mg is required' });
    }
    try {
      res.json({ results: await searchCostPlus({ term: String(term), strength: String(strength), rxcui: String(rxcui) }) });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });
}

module.exports = { mountCostPlusRoutes, searchCostPlus };
