import { buildContentSecurityPolicy, escapeHtml } from './security';

export interface WebviewHtmlOptions {
  title: string;
  /** `asWebviewUri` form of the bundled browser script. */
  scriptUri: string;
  /** `asWebviewUri` form of `styles.css`. */
  stylesUri: string;
  cspSource: string;
  nonce: string;
  /** Class on `<body>` that lets the shared stylesheet lay out the sidebar and editor views differently. */
  bodyClass: string;
}

/** The HTML shell shared by the editor timeline and the Activity Bar branch tree: strict CSP, nonce-loaded script. */
export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  // The CSP only contains the nonce (hex) and the webview's own origin, so it needs no attribute escaping.
  const csp = buildContentSecurityPolicy(options.cspSource, options.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${escapeHtml(options.stylesUri)}" rel="stylesheet">
  <title>${escapeHtml(options.title)}</title>
</head>
<body class="${escapeHtml(options.bodyClass)}">
  <div id="app"></div>
  <script nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>`;
}
