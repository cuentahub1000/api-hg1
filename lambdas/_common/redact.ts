/**
 * What a caller may be told about a failure. Same two rules as the wallet
 * functions: a 5xx message never leaves the process, a 4xx is scrubbed of
 * anything that could only have come from inside (addresses, URIs, errno,
 * paths, stack frames). Applied once, at the envelope.
 */

export const GENERIC_MESSAGE = 'There was an error processing the request';

const MAX_LENGTH = 300;

const SECRETS: Array<[RegExp, string]> = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[address]'],
  [/\[[0-9a-f:]+\](?::\d+)?/gi, '[address]'],
  [/\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{1,4}\b/gi, '[address]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[uri]'],
  [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:amazonaws\.com|internal|local|localdomain|svc|cluster\.local|elb\.[a-z0-9-]+)\b(?::\d+)?/gi, '[host]'],
  [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/gi, '[host]'],
  [/\b(?:E[A-Z]{2,}[0-9A-Z_]*|CERT_[A-Z_]+|SELF_SIGNED[A-Z_]*)\b/g, '[code]'],
  [/(?:\/(?:var|opt|tmp|home|usr|root|srv|app|node_modules)(?:\/[\w.@+-]+)*)(?::\d+:\d+)?/g, '[path]'],
  [/\b[\w.@+-]+\.(?:js|ts|mjs|cjs):\d+:\d+/g, '[path]'],
  [/\bat\s+\S+\s*\([^)]*\)/g, '[frame]'],
];

export function clientMessage(status: number, message: string): string {
  if (status >= 500 || !message) return GENERIC_MESSAGE;
  return redact(message);
}

export function redact(message: string): string {
  let out = String(message).split('\n')[0].trim();
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  out = out.replace(/\b(?:[A-Z][A-Za-z]*)?Error:\s*/g, '').trim();
  if (out.length > MAX_LENGTH) out = `${out.slice(0, MAX_LENGTH - 1)}…`;
  return out || GENERIC_MESSAGE;
}
