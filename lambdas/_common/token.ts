/**
 * Platform JWT verification — the same check the wallet, auth and engagement
 * functions run, so a token minted by `login-auth` validates here unchanged.
 *
 * The secret comes from `JWT_SECRET` (plain env: Kubernetes Secret or a local
 * run) or from Secrets Manager via `JWT_SECRET_ARN`, which holds the secret
 * NAME `<env>/JWTSecret`. The stored value may be plain text or JSON with a
 * `jwt_secret` key. Both the raw secret and its JSON-quoted form are tried,
 * as the authorizer signs with either depending on how its env was read.
 */

import jwt from 'jsonwebtoken';
import { AuthError } from './errors';

let secretCache: Promise<string> | undefined;

function algorithms(): jwt.Algorithm[] {
  const raw = process.env.JWT_ALGORITHMS ?? 'HS256';
  return raw.split(',').map((a) => a.trim()).filter(Boolean) as jwt.Algorithm[];
}

function resolveSecret(): Promise<string> {
  const plain = process.env.JWT_SECRET;
  if (plain) return Promise.resolve(plain);

  if (!secretCache) {
    const secretId = process.env.JWT_SECRET_ARN;
    if (!secretId) return Promise.reject(new AuthError('JWT_SECRET or JWT_SECRET_ARN must be set'));
    secretCache = (async () => {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
      const raw = res.SecretString;
      if (!raw) throw new AuthError(`secret ${secretId} has no SecretString`);
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const value = parsed.jwt_secret ?? parsed.jwtSecret;
          if (typeof value === 'string' && value) return value;
        }
      } catch {
        // plain string secret
      }
      return raw;
    })().catch((err) => {
      secretCache = undefined;
      throw err;
    });
  }
  return secretCache;
}

export type TokenPayload = Record<string, unknown>;

/** The platform secret, raw and JSON-quoted (the authorizer signs with either). Nothing else. */
async function secrets(): Promise<string[]> {
  let raw = await resolveSecret();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  return [`"${raw}"`, raw];
}

export async function verify(token: string): Promise<TokenPayload> {
  if (!token) throw new AuthError('authorization header has empty bearer token');

  let lastErr: unknown;
  for (const candidate of await secrets()) {
    try {
      return jwt.verify(token, candidate, { algorithms: algorithms() }) as TokenPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new AuthError(`token expired: ${err.message}`);
      if (err instanceof jwt.JsonWebTokenError && err.message !== 'invalid signature') {
        throw new AuthError(`invalid token: ${err.message}`);
      }
      lastErr = err;
    }
  }
  throw new AuthError(`invalid token: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
