import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, resourceMatches } from '../../lambdas/_common/permissions';
import { judge } from '../../lambdas/_common/session';
import { ROUTES, requiresFeature } from '../../lambdas/_routes';

test('feature check: ALLOW on the exact tuple, case-insensitive method, placeholder-tolerant resource', () => {
  const f = [{ api: 'api-hg', resource: '/api/v1/payments/admin/payments/:id/approve', action: 'post', effect: 'ALLOW' }];
  assert.equal(check(f, 'api-hg', '/api/v1/payments/admin/payments/{id}/approve', 'POST'), true);
  assert.equal(check(f, 'api-hg', '/api/v1/payments/admin/payments/{id}/reject', 'POST'), false);
  assert.equal(check(f, 'api-hg', '/api/v1/payments/admin/payments/{id}/approve', 'GET'), false);
  assert.equal(check([{ ...f[0], effect: 'DENY' }], 'api-hg', '/api/v1/payments/admin/payments/{id}/approve', 'POST'), false);
  assert.equal(check([{ ...f[0], api: 'api-wallet' }], 'api-hg', '/api/v1/payments/admin/payments/{id}/approve', 'POST'), false);
});

test('resourceMatches: one segment per placeholder, never more', () => {
  assert.equal(resourceMatches('/a/{id}/b', '/a/{id}/b'), true);
  assert.equal(resourceMatches('/a/:id/b', '/a/{id}/b'), true);
  assert.equal(resourceMatches('/a/{id}/b', '/a/x/y/b'), false);
  assert.equal(resourceMatches('/a/{id}', '/a/{id}/b'), false);
});

test('every operator route that changes something requires a feature; reads and player routes do not', () => {
  for (const r of ROUTES) {
    assert.equal(requiresFeature(r), r.audience === 'operator' && r.method !== 'GET', r.slug);
  }
});

test('session judge: valid passes, revoked/expired refuse, missing passes only for a fresh token', () => {
  assert.doesNotThrow(() => judge('valid', undefined));
  assert.throws(() => judge('revoked', 1000, 1000), /no longer valid/);
  assert.throws(() => judge('expired', 1000, 1000), /no longer valid/);
  assert.doesNotThrow(() => judge('missing', 1000, 1005));
  assert.throws(() => judge('missing', 1000, 1100), /not found/);
  assert.throws(() => judge('missing', undefined), /not found/);
});
