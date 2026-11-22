import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../../lambdas/_domain/providers/hg';
import { needsHold, DEFAULTS } from '../../lambdas/_domain/settings';
import { decodeCursor, encodeCursor } from '../../lambdas/_domain/payments';
import { maskDestination, playerView, adminView, type PaymentRow } from '../../lambdas/_domain/types';
import { amount, destination, listFilter, paymentId } from '../../lambdas/_common/input';
import { ValidationError } from '../../lambdas/_common/errors';

const settings = { ...DEFAULTS, currency: 'ARS', updatedAt: null, updatedBy: null };

describe('needsHold', () => {
  it('holds every withdrawal by default and no deposit', () => {
    assert.equal(needsHold('withdrawal', 10, settings), true);
    assert.equal(needsHold('deposit', 10, settings), false);
  });
  it('holds above a threshold', () => {
    const s = { ...settings, holdWithdrawals: false, holdWithdrawalsAbove: 500, holdDepositsAbove: 1000 };
    assert.equal(needsHold('withdrawal', 499.99, s), false);
    assert.equal(needsHold('withdrawal', 500, s), true);
    assert.equal(needsHold('deposit', 1000, s), true);
  });
});

describe('webhook signature', () => {
  const secret = 'whsec';
  const body = '{"topic":"CHECKOUT","id":"x"}';
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  it('accepts the exact HMAC, with or without the prefix, any case', () => {
    assert.equal(verifySignature(body, `sha256=${sig}`, secret), true);
    assert.equal(verifySignature(body, sig.toUpperCase(), secret), true);
  });
  it('rejects a tampered body, a wrong secret, a missing header or no secret', () => {
    assert.equal(verifySignature(body + ' ', `sha256=${sig}`, secret), false);
    assert.equal(verifySignature(body, `sha256=${sig}`, 'other'), false);
    assert.equal(verifySignature(body, undefined, secret), false);
    assert.equal(verifySignature(body, `sha256=${sig}`, ''), false);
  });
});

describe('cursor', () => {
  it('round-trips and refuses garbage', () => {
    const c = { at: '2026-11-16T10:00:00.000Z', id: 'abc' };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
    assert.equal(decodeCursor(undefined), undefined);
    assert.throws(() => decodeCursor('not-a-cursor'));
  });
});

const row: PaymentRow = {
  id: '3f0c0a2e-0000-4000-8000-000000000001', kind: 'withdrawal', status: 'rejected', tenant: 'root1', party_id: 'p1', username: 'ana',
  chain: 'root1-a1', account_id: '42', currency: 'ARS', amount: '1500.50', fee: null, hold: true, provider: 'hg', wallet_operation_id: 'op1', wallet_status: 'CANCELED',
  destination: { type: 'cvu', value: '0000003100012345678901', holderName: 'Ana' }, payer: null, document_hash: null, client: null, note: 'Above limit', decided_by: 'agent1', decided_by_name: 'Agent One', decided_at: null,
  error_code: null, priority: null, created_at: '2026-11-16T10:00:00.000Z', updated_at: '2026-11-16T10:01:00.000Z', completed_at: null, version: 3,
  p_ref: null, p_status: null, p_checkout_url: null, p_expires_at: null, p_data: null,
};

describe('views', () => {
  it('masks the destination and exposes only the rejection note to the player', () => {
    const v = playerView(row);
    assert.equal(v.destination?.value, '•••• 8901');
    assert.equal(v.amount, 1500.5);
    assert.equal(v.note, 'Above limit');
    assert.equal((v as unknown as Record<string, unknown>).partyId, undefined);
    assert.equal(maskDestination(null), null);
  });
  it('gives the operator the full destination and the internals', () => {
    const a = adminView(row);
    assert.equal(a.destination?.value, '0000003100012345678901');
    assert.equal(a.walletOperationId, 'op1');
    assert.equal(a.partyId, 'p1');
  });
  it('shows the checkout url only while pending', () => {
    const pending = { ...row, kind: 'deposit' as const, status: 'pending' as const, p_checkout_url: 'https://pay/x' };
    assert.equal(playerView(pending).checkoutUrl, 'https://pay/x');
    assert.equal(playerView({ ...pending, status: 'completed' }).checkoutUrl, null);
  });
});

describe('input', () => {
  it('amounts: positive, two decimals', () => {
    assert.equal(amount({ amount: '1500.5' }), 1500.5);
    assert.equal(amount({ amount: 20 }), 20);
    for (const bad of [0, -1, 'abc', 1.005, undefined]) assert.throws(() => amount({ amount: bad }), ValidationError);
  });
  it('destinations: 22 digits, cbu or cvu', () => {
    assert.deepEqual(destination({ destination: { type: 'cbu', value: '0170 0992 2000 0006 7797 37' } }), { type: 'cbu', value: '0170099220000006779737', holderName: undefined });
    assert.throws(() => destination({ destination: { type: 'alias', value: 'x' } }), ValidationError);
    assert.throws(() => destination({ destination: { type: 'cvu', value: '123' } }), ValidationError);
  });
  it('list filters: open expands, unknown status fails, limit is clamped', () => {
    const f = listFilter({ status: 'open', limit: '10' }, { limit: 50, max: 200 });
    assert.ok(f.statuses!.includes('pending') && !f.statuses!.includes('completed'));
    assert.equal(f.limit, 10);
    assert.throws(() => listFilter({ status: 'weird' }, { limit: 50, max: 200 }), ValidationError);
    assert.throws(() => listFilter({ limit: '999' }, { limit: 50, max: 200 }), ValidationError);
  });
  it('payment ids must be uuids', () => {
    assert.equal(paymentId({ id: '3F0C0A2E-0000-4000-8000-000000000001' }), '3f0c0a2e-0000-4000-8000-000000000001');
    assert.throws(() => paymentId({ id: "1; drop table payment" }), ValidationError);
  });
});
