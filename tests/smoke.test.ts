import { describe, expect, it } from 'vitest';
import { isExtensionToWebviewMessage, isWebviewToExtensionMessage } from '../src/types/messages';
import { buildContentSecurityPolicy, escapeHtml, getNonce } from '../src/webview/security';

describe('message type guards', () => {
  it('accepts every known webview -> extension message', () => {
    for (const type of ['webviewReady', 'openRepositoryPanel', 'requestRefresh']) {
      expect(isWebviewToExtensionMessage({ type })).toBe(true);
    }
  });

  it('rejects unknown or malformed webview messages', () => {
    expect(isWebviewToExtensionMessage({ type: 'runShell' })).toBe(false);
    expect(isWebviewToExtensionMessage({})).toBe(false);
    expect(isWebviewToExtensionMessage(null)).toBe(false);
    expect(isWebviewToExtensionMessage('webviewReady')).toBe(false);
  });

  it('validates payloads of webview -> extension messages', () => {
    expect(isWebviewToExtensionMessage({ type: 'checkoutBranch', payload: { branchName: 'feature/x' } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'checkoutBranch', payload: { branchName: '' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'checkoutBranch' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'gitAction', payload: { action: 'push' } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'gitAction', payload: { action: 'reset --hard' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'gitAction', payload: { action: 'toString' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'copyCommitHash', payload: { hash: 'a'.repeat(40) } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'copyCommitHash', payload: { hash: 'not-a-hash' } })).toBe(false);
  });

  it('validates initState payloads', () => {
    expect(isExtensionToWebviewMessage({ type: 'initState', payload: { repoName: 'r', workspacePath: null } })).toBe(true);
    expect(isExtensionToWebviewMessage({ type: 'initState', payload: { repoName: 'r', workspacePath: '/x' } })).toBe(true);
    expect(isExtensionToWebviewMessage({ type: 'initState', payload: { repoName: 1, workspacePath: null } })).toBe(false);
    expect(isExtensionToWebviewMessage({ type: 'initState' })).toBe(false);
  });
});

describe('webview security helpers', () => {
  it('generates unique 32-char hex nonces', () => {
    const a = getNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(getNonce()).not.toBe(a);
  });

  it('builds a CSP that denies by default and requires the script nonce', () => {
    const csp = buildContentSecurityPolicy('vscode-webview://abc', 'n0nce');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
