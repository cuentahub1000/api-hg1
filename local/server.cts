/**
 * Local Lambda invoke shim for api-hg (same shape as auth-lambda's `local/`).
 *
 * One HTTP server that stands in for the AWS endpoints a function and its
 * callers talk to, so front-self and the back-office can invoke these
 * handlers on a laptop with `API_HG_MODE=lambda` and
 * `API_HG_LAMBDA_ENDPOINT=http://127.0.0.1:9500`:
 *
 *   POST /2015-03-31/functions/<name>/invocations   Lambda `Invoke`
 *   POST /  (x-amz-target: secretsmanager.*)         Secrets Manager `GetSecretValue`
 *   POST /webhook                                     the provider callback, as a Function URL would deliver it
 *   GET  /                                            what is served, for a sanity check
 *
 * A function name is resolved by suffix: `<anything>-hg-<slug>` runs
 * `lambdas/<slug>/index.ts`, bundled on first use with the same esbuild
 * settings as the CDK stack. Handlers run in this process, so
 * `local/lambda.env` *is* their environment. Secrets come from
 * `LOCAL_SECRETS_FILE` (default `local/secrets.json`), re-read on every call.
 *
 * Not a Lambda runtime: no timeout, no memory cap, no cold start, and the pg
 * client lives as long as the process.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

const http: typeof import('node:http') = require('node:http');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const esbuild: typeof import('esbuild') = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const LAMBDAS = path.join(ROOT, 'lambdas');
const DIST = path.join(ROOT, 'local', 'dist');
const PORT = Number(process.env.LOCAL_LAMBDA_PORT || 9500);
const SECRETS_FILE = path.resolve(ROOT, process.env.LOCAL_SECRETS_FILE || 'local/secrets.json');
const INFIX = '-hg-';

type Handler = (event: unknown) => Promise<unknown>;

function slugs(): string[] {
  return fs
    .readdirSync(LAMBDAS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .filter((d) => fs.existsSync(path.join(LAMBDAS, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();
}

function slugOf(functionName: string): string | undefined {
  return slugs().find((slug) => functionName.endsWith(`${INFIX}${slug}`));
}

/** `(resource, method)` from `lambdas/_routes.ts`, read by text so an edit takes effect without a restart. */
function specOf(slug: string): { resource: string; method: string } | undefined {
  const source = fs.readFileSync(path.join(LAMBDAS, '_routes.ts'), 'utf8');
  const re = /\{\s*slug:\s*'([^']+)'\s*,\s*method:\s*'([A-Z]+)'\s*,\s*resource:\s*'([^']+)'/g;
  for (const m of source.matchAll(re)) if (m[1] === slug) return { resource: m[3], method: m[2] };
  return undefined;
}

const handlers = new Map<string, Promise<Handler>>();

async function bundle(slug: string): Promise<Handler> {
  const outfile = path.join(DIST, `${slug}.js`);
  await esbuild.build({
    entryPoints: [path.join(LAMBDAS, slug, 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: 'inline',
    external: ['@aws-sdk/*', 'pg-native'],
    logLevel: 'warning',
  });
  delete require.cache[require.resolve(outfile)];
  const mod = require(outfile) as { handler?: Handler };
  if (typeof mod.handler !== 'function') throw new Error(`lambdas/${slug}/index.ts does not export a handler`);
  return mod.handler;
}

function handlerFor(slug: string): Promise<Handler> {
  let pending = handlers.get(slug);
  if (!pending) {
    pending = bundle(slug).catch((err) => { handlers.delete(slug); throw err; });
    handlers.set(slug, pending);
  }
  return pending;
}

function secrets(): Record<string, unknown> {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

function lambdaError(res: ServerResponse, status: number, type: string, message: string): void {
  send(res, status, { Type: 'User', Message: message }, { 'x-amzn-errortype': type });
}

function jsonError(res: ServerResponse, type: string, message: string): void {
  send(res, 400, { __type: type, Message: message }, { 'content-type': 'application/x-amz-json-1.1' });
}

async function runHandler(slug: string, event: unknown): Promise<unknown> {
  process.env.FUNCTION_NAME = slug;
  const spec = specOf(slug);
  if (spec) {
    process.env.PAYMENTS_RESOURCE = spec.resource;
    process.env.PAYMENTS_METHOD = spec.method;
  }
  const handler = await handlerFor(slug);
  return handler(event);
}

async function invoke(req: IncomingMessage, res: ServerResponse, functionName: string): Promise<void> {
  const slug = slugOf(functionName);
  if (!slug) {
    console.warn(`[local] no function for ${functionName}`);
    return lambdaError(res, 404, 'ResourceNotFoundException', `Function not found: ${functionName}`);
  }
  const raw = await readBody(req);
  let event: unknown = {};
  if (raw.trim()) {
    try { event = JSON.parse(raw); } catch { return lambdaError(res, 400, 'InvalidRequestContentException', 'Could not parse request body into json'); }
  }
  const invocationType = String(req.headers['x-amz-invocation-type'] ?? 'RequestResponse');
  const started = Date.now();
  let result: unknown;
  try {
    result = await runHandler(slug, event);
  } catch (err) {
    const e = err as Error;
    console.error(`[local] ${slug} raised after ${Date.now() - started}ms:`, e?.stack ?? e);
    if (invocationType === 'Event') return send(res, 202, '');
    return send(res, 200, { errorType: e?.name ?? 'Error', errorMessage: e?.message ?? String(err), trace: (e?.stack ?? '').split('\n') },
      { 'x-amz-function-error': 'Unhandled', 'x-amz-executed-version': '$LATEST' });
  }
  const env = result as { ok?: boolean; statusCode?: number; error?: { type?: string } } | undefined;
  const outcome = env?.ok === true ? 'ok' : env?.ok === false ? `${env.statusCode} ${env.error?.type ?? ''}`.trim() : 'no envelope';
  console.log(`[local] ${slug} → ${outcome} (${Date.now() - started}ms)`);
  if (invocationType === 'Event') return send(res, 202, '');
  send(res, 200, result === undefined ? 'null' : JSON.stringify(result), { 'x-amz-executed-version': '$LATEST' });
}

/**
 * The fake hosted payment page (`PROVIDER_MODE=mock`). The sandbox state lives
 * inside the handlers' bundle, so the page is served through a tiny entry
 * bundled the same way (`lambdas/_domain/sandbox.ts` + `payments.ts`).
 */
let sandboxMod: Promise<{ handleSandbox: (m: string, p: string) => Promise<{ status: number; contentType: string; body: string; location?: string } | null> }> | undefined;
function sandbox() {
  if (!sandboxMod) {
    const outfile = path.join(DIST, '_sandbox.js');
    sandboxMod = esbuild.build({ entryPoints: [path.join(LAMBDAS, '_domain', 'providers', 'sandbox.ts')], outfile, bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: 'inline', external: ['@aws-sdk/*', 'pg-native'], logLevel: 'warning' })
      .then(() => { delete require.cache[require.resolve(outfile)]; return require(outfile); });
  }
  return sandboxMod;
}

/** The provider's callback, delivered the way a Function URL would (raw body, headers). */
async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const out = (await runHandler('webhook', { requestContext: { http: { method: 'POST' } }, headers, body: raw, isBase64Encoded: false })) as { statusCode: number; body: string };
  send(res, out.statusCode, out.body);
}

async function getSecretValue(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
  if (target !== 'secretsmanager.GetSecretValue') return jsonError(res, 'UnsupportedOperation', `${target} is not served by the local shim`);
  let secretId: string | undefined;
  try { secretId = (JSON.parse((await readBody(req)) || '{}') as { SecretId?: string }).SecretId; } catch { return jsonError(res, 'InvalidRequestException', 'Could not parse request body into json'); }
  if (!secretId) return jsonError(res, 'ValidationException', 'SecretId is required');
  const all = secrets();
  const name = secretId.startsWith('arn:') ? secretId.split(':secret:')[1]?.replace(/-[A-Za-z0-9]{6}$/, '') ?? secretId : secretId;
  if (!(name in all)) {
    console.warn(`[local] secret not in ${path.relative(ROOT, SECRETS_FILE)}: ${name}`);
    return jsonError(res, 'ResourceNotFoundException', `Secrets Manager can't find the specified secret: ${name}`);
  }
  const value = all[name];
  send(res, 200, {
    ARN: `arn:aws:secretsmanager:${process.env.AWS_REGION || 'us-east-1'}:000000000000:secret:${name}-local0`,
    Name: name, VersionId: 'local', VersionStages: ['AWSCURRENT'],
    SecretString: typeof value === 'string' ? value : JSON.stringify(value), CreatedDate: 0,
  }, { 'content-type': 'application/x-amz-json-1.1' });
}

const INVOKE = /^\/2015-03-31\/functions\/([^/]+)\/invocations\/?$/;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const target = req.headers['x-amz-target'];
  (async () => {
    const m = url.pathname.match(INVOKE);
    if (req.method === 'POST' && m) return invoke(req, res, decodeURIComponent(m[1]));
    if (req.method === 'POST' && url.pathname === '/webhook') return webhook(req, res);
    if (url.pathname.startsWith('/sandbox')) {
      const out = await (await sandbox()).handleSandbox(req.method ?? 'GET', url.pathname);
      if (out) { res.writeHead(out.status, { 'content-type': out.contentType, ...(out.location ? { location: out.location } : {}) }); res.end(out.body); return; }
    }
    if (req.method === 'POST' && typeof target === 'string' && target.startsWith('secretsmanager.')) return getSecretValue(req, res, target);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/_health')) {
      return send(res, 200, { functions: slugs().map((s) => `<env>${INFIX}${s}`), webhook: `http://127.0.0.1:${PORT}/webhook`, secrets: Object.keys(secrets()), secretsFile: path.relative(ROOT, SECRETS_FILE) });
    }
    if (typeof target === 'string') return jsonError(res, 'UnsupportedOperation', `${target} is not served by the local shim`);
    send(res, 404, { message: `no route for ${req.method} ${url.pathname}` });
  })().catch((err) => {
    console.error('[local] unexpected failure', err);
    if (!res.headersSent) send(res, 500, { message: String(err) }); else res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local] hg lambdas on http://127.0.0.1:${PORT}  (${slugs().length} functions, secrets from ${path.relative(ROOT, SECRETS_FILE)})`);
  console.log(`[local] invoke: POST /2015-03-31/functions/<env>-hg-<slug>/invocations   e.g. local/invoke.sh payments-list`);
  if (!fs.existsSync(SECRETS_FILE)) console.warn(`[local] ${path.relative(ROOT, SECRETS_FILE)} is missing — copy local/secrets.example.json`);
  if (!process.env.JWT_SECRET && !process.env.JWT_SECRET_ARN) console.warn('[local] JWT_SECRET is not set — every call will be a 401');
});
