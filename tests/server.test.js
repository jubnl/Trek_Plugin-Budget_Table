'use strict';
// Unit tests for the Budget Table server routes, driven by the SDK's mock host.
// The mock enforces the SAME permission model as TREK, so these prove the routes
// degrade correctly (403) and forward only the whitelisted fields.
const test = require('node:test');
const assert = require('node:assert');
const { createMockHost } = require('trek-plugin-sdk/testing');

// Stub the frankfurter FX endpoint so tests never hit the network. Must be set
// before requiring the plugin isn't necessary (fetch is read at call time), but
// we set it up front regardless.
globalThis.fetch = async function () {
  return { async json() { return [{ quote: 'EUR', rate: 1.08 }, { quote: 'USD', rate: 1.24 }]; } };
};

const plugin = require('../server/index.js');

const GRANTS = ['db:read:trips', 'db:read:costs', 'db:write:costs', 'http:outbound:api.frankfurter.dev'];

function route(method, path) {
  const r = plugin.routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error('no route ' + method + ' ' + path);
  return r;
}

// Build a fresh mock host + a helper that calls a route and parses the JSON reply.
function harness(overrides = {}) {
  const host = createMockHost({
    grants: overrides.grants || GRANTS,
    actingUserId: 1,
    budgetAddonEnabled: overrides.budgetAddonEnabled,
    trips: {
      1: {
        members: [1],
        canEditCosts: overrides.canEditCosts,
        data: { id: 1, title: 'Trip', currency: 'CHF' },
        costs: overrides.costs || [],
      },
    },
  });
  async function call(method, path, { query = {}, body, user = { id: 1, username: 'dev', isAdmin: false } } = {}) {
    const res = await route(method, path).handler({ method, path, query, body, user }, host.ctx);
    let parsed = null;
    try { parsed = res.body ? JSON.parse(res.body) : null; } catch (e) { parsed = res.body; }
    return { status: res.status, data: parsed };
  }
  return { host, call };
}

test('GET /items returns base currency and items', async () => {
  const { call } = harness({ costs: [{ id: 5, category: 'food', name: 'Ramen', total_price: 12 }] });
  const res = await call('GET', '/items', { query: { tripId: '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.baseCurrency, 'CHF');
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].name, 'Ramen');
});

test('GET /items returns tripCurrency and live rates for the requested base', async () => {
  const { call } = harness({ costs: [{ id: 1, category: 'food', name: 'X', total_price: 10, currency: 'EUR' }] });
  const res = await call('GET', '/items', { query: { tripId: '1', base: 'CHF' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.baseCurrency, 'CHF');
  assert.equal(res.data.tripCurrency, 'CHF');
  assert.equal(res.data.rates.CHF, 1);      // base self-rate seeded
  assert.equal(res.data.rates.EUR, 1.08);   // from the stubbed endpoint
});

test('GET /items falls back to the trip currency when no base is given', async () => {
  const { call } = harness();
  const res = await call('GET', '/items', { query: { tripId: '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.baseCurrency, 'CHF'); // trip.currency
});

test('GET /items without tripId is a 400', async () => {
  const { call } = harness();
  const res = await call('GET', '/items', { query: {} });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'BAD_PARAMS');
});

test('GET /items without db:read:costs is a 403', async () => {
  const { call } = harness({ grants: ['db:read:trips'] });
  const res = await call('GET', '/items', { query: { tripId: '1' } });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'PERMISSION_DENIED');
});

test('GET /items with the budget addon disabled is a 403', async () => {
  const { call } = harness({ budgetAddonEnabled: false });
  const res = await call('GET', '/items', { query: { tripId: '1' } });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'RESOURCE_FORBIDDEN');
});

test('POST /items creates an item and strips non-whitelisted fields', async () => {
  const { host, call } = harness();
  const res = await call('POST', '/items', {
    query: { tripId: '1' },
    // payers/id/trip_id must be dropped by pickWritable — only planning fields pass.
    body: { name: 'Hotel', category: 'accommodation', total_price: 90, persons: 2, days: 3,
      expense_date: '2026-08-01', note: 'x', payers: [{ user_id: 9, amount: 90 }], id: 999 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.name, 'Hotel');
  assert.equal(res.data.category, 'accommodation');
  assert.equal(res.data.total_price, 90);
  assert.ok(!('payers' in res.data), 'payers should not be forwarded');
  assert.equal(host.ctx ? true : false, true);
});

test('POST /items requires a name', async () => {
  const { call } = harness();
  const res = await call('POST', '/items', { query: { tripId: '1' }, body: { name: '   ' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'BAD_PARAMS');
});

test('POST /items is a 403 when the user cannot edit costs', async () => {
  const { call } = harness({ canEditCosts: false });
  const res = await call('POST', '/items', { query: { tripId: '1' }, body: { name: 'X' } });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'RESOURCE_FORBIDDEN');
});

test('PATCH /items updates only the given whitelisted fields', async () => {
  const { call } = harness({ costs: [{ id: 7, category: 'food', name: 'Old', total_price: 10 }] });
  const res = await call('PATCH', '/items', {
    query: { tripId: '1', id: '7' },
    body: { name: 'New', bogus: 'nope' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, 'New');
  assert.ok(!('bogus' in res.data), 'unknown field should be stripped');
});

test('PATCH /items with no writable fields is a 400', async () => {
  const { call } = harness({ costs: [{ id: 7, name: 'Old' }] });
  const res = await call('PATCH', '/items', { query: { tripId: '1', id: '7' }, body: { bogus: 1 } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'BAD_PARAMS');
});

test('PATCH /items without an id is a 400', async () => {
  const { call } = harness({ costs: [{ id: 7, name: 'Old' }] });
  const res = await call('PATCH', '/items', { query: { tripId: '1' }, body: { name: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, 'BAD_PARAMS');
});

test('DELETE /items removes the item', async () => {
  const { call } = harness({ costs: [{ id: 7, name: 'Old' }] });
  const res = await call('DELETE', '/items', { query: { tripId: '1', id: '7' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.deleted, true);
  const after = await call('GET', '/items', { query: { tripId: '1' } });
  assert.equal(after.data.items.length, 0);
});

test('DELETE /items for a missing item is a 403', async () => {
  const { call } = harness({ costs: [] });
  const res = await call('DELETE', '/items', { query: { tripId: '1', id: '999' } });
  assert.equal(res.status, 403);
});
