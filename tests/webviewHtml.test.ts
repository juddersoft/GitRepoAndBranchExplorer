import { describe, expect, it } from 'vitest';
import { renderWebviewHtml } from '../src/webview/webviewHtml';

const options = {
  title: 'Repository Explorer',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/sidebar.js',
  stylesUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/src/webview/ui/styles.css',
  cspSource: 'https://*.vscode-cdn.net',
  nonce: 'abc123',
  bodyClass: 'sidebar-view',
};

describe('renderWebviewHtml', () => {
  const html = renderWebviewHtml(options);

  it('loads exactly one script, by nonce and webview URI, and no inline script', () => {
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="abc123" src="${options.scriptUri}"></script>`);
  });

  it('sets a nonce-based CSP that denies everything by default', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain('style-src https://*.vscode-cdn.net');
  });

  it('links the shared stylesheet and mounts the app root with the view-specific body class', () => {
    expect(html).toContain(`<link href="${options.stylesUri}" rel="stylesheet">`);
    expect(html).toContain('<body class="sidebar-view">');
    expect(html).toContain('<div id="app"></div>');
  });

  it('escapes values that end up in attributes or text', () => {
    const hostile = renderWebviewHtml({ ...options, title: '<b>x</b>', bodyClass: '"><script>', stylesUri: 'a"b' });
    expect(hostile).not.toContain('<b>x</b>');
    expect(hostile).not.toContain('"><script>');
    expect(hostile).toContain('href="a&quot;b"');
  });
});
