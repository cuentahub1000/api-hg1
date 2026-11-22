import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { compile, match, toHttp, type Handler } from '../../server/router';
import { ROUTES } from '../../lambdas/_routes';

const handlers = Object.fromEntries(ROUTES.map((r) => [r.slug, (async () => ({ ok: true as const, data: r.slug })) as Handler]));

describe('router', () => {
  const routes = compile(handlers);
  it('matches every declared route and extracts path params', () => {
    const slugOf = (method: string, path: string) => { const m = match(routes, method, path); return m && m !== 'method' ? m : null; };
    const m = slugOf('POST', '/api/v1/payments/withdrawals/3f0c0a2e-0000-4000-8000-000000000001/cancel');
    assert.equal(m?.route.spec.slug, 'withdrawals-cancel');
    assert.equal(m?.path.id, '3f0c0a2e-0000-4000-8000-000000000001');
    assert.equal(slugOf('GET', '/api/v1/payments')?.route.spec.slug, 'payments-list');
    assert.equal(slugOf('GET', '/api/v1/payments/abc')?.route.spec.slug, 'payments-get');
    assert.equal(slugOf('GET', '/api/v1/payments/admin/settings')?.route.spec.slug, 'admin-settings-get');
  });
  it('reports method mismatch and unknown paths', () => {
    assert.equal(match(routes, 'DELETE', '/api/v1/payments'), 'method');
    assert.equal(match(routes, 'GET', '/nope'), null);
  });
  it('reshapes a failure into the legacy body', () => {
    const out = toHttp({ ok: false, statusCode: 422, error: { type: 'LIMIT_EXCEEDED', message: 'm', description: 'd' } });
    assert.equal(out.status, 422);
    assert.deepEqual(out.body, { errorCode: 'LIMIT_EXCEEDED', message: 'm', description: 'd', statusCode: 422 });
  });
  it('every route has a handler slot in the HTTP server', () => {
    for (const r of ROUTES) assert.ok(handlers[r.slug], r.slug);
  });
});
