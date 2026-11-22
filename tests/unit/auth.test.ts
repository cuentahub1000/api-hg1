import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import jwt from 'jsonwebtoken';
import { fromDecodedToken } from '../../lambdas/_common/auth';
import { paymentsHandler } from '../../lambdas/_common/handler';

const SECRET = 'unit-test-secret';
const sign = (payload: Record<string, unknown>) => jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const PLAYER = { id: 7, username: 'ana', identifier: 'u-ana', metadata: { partyId: 'p-ana', chain: 'root1-agent1', partyType: 'person' } };
const AGENT = { id: 8, username: 'agent1', identifier: 'u-agent1', metadata: { partyId: 'agent1', chain: 'root1', partyType: 'organization' } };

describe('fromDecodedToken', () => {
  it('classifies persons as players and everything else as operators', () => {
    assert.equal(fromDecodedToken(PLAYER).audience, 'player');
    assert.equal(fromDecodedToken(PLAYER).fullChain, 'root1-agent1-p-ana');
    assert.equal(fromDecodedToken(AGENT).audience, 'operator');
  });
});

describe('paymentsHandler', () => {
  before(() => { process.env.JWT_SECRET = SECRET; });
  it('rejects a missing token with 401 and a wrong audience with 403', async () => {
    const h = paymentsHandler('admin-payments-list', async () => 'ok');
    const noToken = await h({});
    assert.equal(noToken.ok, false);
    if (!noToken.ok) assert.equal(noToken.statusCode, 401);
    const player = await h({ headers: { authorization: `Bearer ${sign(PLAYER)}` } });
    assert.equal(player.ok, false);
    if (!player.ok) assert.equal(player.statusCode, 403);
    const agent = await h({ headers: { authorization: `Bearer ${sign(AGENT)}` } });
    assert.deepEqual(agent, { ok: true, data: 'ok' });
  });
  it('refuses pre-decoded identities', async () => {
    const h = paymentsHandler('payments-list', async () => 'ok');
    const r = await h({ headers: { 'x-auth-decoded-token': JSON.stringify(PLAYER) } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 401);
  });
  it('hides 5xx detail and keeps 4xx messages', async () => {
    const boom = paymentsHandler('payments-list', async () => { throw new Error('ECONNREFUSED 10.0.0.1:5432'); });
    const r = await boom({ headers: { authorization: `Bearer ${sign(PLAYER)}` } });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.statusCode, 500); assert.ok(!r.error.message.includes('10.0.0.1')); }
  });
});
