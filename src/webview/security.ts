import * as crypto from 'crypto';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Builds a restrictive CSP: nothing is allowed by default; scripts require the nonce,
 * styles/images/fonts may only come from the webview's own resource origin.
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    `style-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

export const buildCspHeader = buildContentSecurityPolicy;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
