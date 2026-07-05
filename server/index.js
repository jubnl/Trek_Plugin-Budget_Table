// Built plugin entry — runs in an isolated child process.
// Thin data layer over ctx.costs for the Budget Table trip-page plugin.
const { definePlugin } = require('trek-plugin-sdk');

// Fields the client is allowed to write. `total_price`/`currency` are only
// forwarded when the client determined the item has no payers (see client) —
// editing them on a payer-backed item would desync settlement.
const WRITABLE_FIELDS = [
  'name',
  'category',
  'total_price',
  'currency',
  'persons',
  'days',
  'expense_date',
  'note',
];

// --- Live FX rates -----------------------------------------------------------
// TREK's own Costs panel converts every amount into the user's display currency
// using api.frankfurter.dev (keyless). We mirror that server-side and cache per
// base in-process. rates[X] = units of X per 1 base, so amount/rates[C] → base.
const RATE_TTL_MS = 6 * 60 * 60 * 1000; // 6h, same as TREK's client cache
const rateCache = new Map(); // base -> { rates, ts }

async function fetchRates(base) {
  const cached = rateCache.get(base);
  if (cached && Date.now() - cached.ts < RATE_TTL_MS) return cached.rates;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 5000);
    const res = await fetch('https://api.frankfurter.dev/v2/rates?base=' + encodeURIComponent(base), { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const rates = {}; rates[base] = 1; // frankfurter omits the base's self-rate
    if (Array.isArray(data)) {
      for (const r of data) if (r && typeof r.quote === 'string' && typeof r.rate === 'number') rates[r.quote] = r.rate;
    } else if (data && data.rates && typeof data.rates === 'object') {
      for (const k in data.rates) if (typeof data.rates[k] === 'number') rates[k] = data.rates[k];
    }
    rateCache.set(base, { rates: rates, ts: Date.now() });
    return rates;
  } catch (e) {
    if (cached) return cached.rates; // stale is better than nothing
    const identity = {}; identity[base] = 1;
    return identity;
  }
}

function json(status, data) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// A failed ctx.* call rejects with an Error whose message is prefixed by the
// RPC error code (e.g. "PERMISSION_DENIED: …"). Map that to an HTTP status.
function errorResponse(err) {
  const message = (err && err.message) || 'Unexpected error';
  const code = message.split(':', 1)[0];
  const statusByCode = {
    PERMISSION_DENIED: 403,
    RESOURCE_FORBIDDEN: 403,
    BAD_PARAMS: 400,
    UNKNOWN_METHOD: 501,
    TIMEOUT: 504,
  };
  const status = statusByCode[code] || 500;
  return json(status, { error: message, code });
}

function parseBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }
  return typeof body === 'object' ? body : {};
}

// Keep only the whitelisted, defined fields so we never forward stray keys
// (and never touch payers/members) to ctx.costs.
function pickWritable(input) {
  const out = {};
  for (const key of WRITABLE_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

function requireTripId(req) {
  const tripId = Number(req.query && req.query.tripId);
  if (!Number.isFinite(tripId) || tripId <= 0) {
    const err = new Error('BAD_PARAMS: missing or invalid tripId');
    throw err;
  }
  return tripId;
}

function requireItemId(req) {
  const id = Number(req.query && req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('BAD_PARAMS: missing or invalid id');
  }
  return id;
}

module.exports = definePlugin({
  async onLoad(ctx) {
    ctx.log.info('budget-table loaded');
  },

  routes: [
    // List every budget item on the trip plus the trip's base currency.
    {
      method: 'GET', path: '/items', auth: true,
      async handler(req, ctx) {
        try {
          const tripId = requireTripId(req);
          const [items, trip] = await Promise.all([
            ctx.costs.getByTrip(tripId),
            ctx.trips.getById(tripId).catch(() => null),
          ]);
          const tripCurrency = String((trip && trip.currency) || 'EUR').toUpperCase();
          // The client passes its display currency (from trek:context formats.currency).
          // Fall back to the trip currency when absent or malformed.
          const wanted = String((req.query && req.query.base) || '').toUpperCase();
          const baseCurrency = /^[A-Z]{3}$/.test(wanted) ? wanted : tripCurrency;
          const rates = await fetchRates(baseCurrency);
          return json(200, { baseCurrency, tripCurrency, rates, items: items || [] });
        } catch (err) {
          ctx.log.warn('GET /items failed', { error: String(err) });
          return errorResponse(err);
        }
      },
    },

    // Create a planning-only expense (no payers/members → total stays editable).
    {
      method: 'POST', path: '/items', auth: true,
      async handler(req, ctx) {
        try {
          const tripId = requireTripId(req);
          const input = pickWritable(parseBody(req.body));
          if (!input.name || String(input.name).trim() === '') {
            return json(400, { error: 'BAD_PARAMS: name is required', code: 'BAD_PARAMS' });
          }
          const created = await ctx.costs.create(tripId, input);
          return json(201, created);
        } catch (err) {
          ctx.log.warn('POST /items failed', { error: String(err) });
          return errorResponse(err);
        }
      },
    },

    // Patch the changed field(s) of one expense. Only whitelisted fields; the
    // client omits total_price/currency for payer-backed items.
    {
      method: 'PATCH', path: '/items', auth: true,
      async handler(req, ctx) {
        try {
          const tripId = requireTripId(req);
          const itemId = requireItemId(req);
          const input = pickWritable(parseBody(req.body));
          if (Object.keys(input).length === 0) {
            return json(400, { error: 'BAD_PARAMS: no writable fields', code: 'BAD_PARAMS' });
          }
          const updated = await ctx.costs.update(tripId, itemId, input);
          return json(200, updated);
        } catch (err) {
          ctx.log.warn('PATCH /items failed', { error: String(err) });
          return errorResponse(err);
        }
      },
    },

    // Delete one expense.
    {
      method: 'DELETE', path: '/items', auth: true,
      async handler(req, ctx) {
        try {
          const tripId = requireTripId(req);
          const itemId = requireItemId(req);
          const result = await ctx.costs.delete(tripId, itemId);
          return json(200, result);
        } catch (err) {
          ctx.log.warn('DELETE /items failed', { error: String(err) });
          return errorResponse(err);
        }
      },
    },
  ],
});
