import * as vscode from 'vscode';
import { getNonce } from './security';
import { renderWebviewHtml } from './webviewHtml';

export type WebviewEntry = 'webview' | 'sidebar';

const ENTRY_PAGES: Readonly<Record<WebviewEntry, { title: string; bodyClass: string }>> = {
  webview: { title: 'Git Repository', bodyClass: 'editor-view' },
  sidebar: { title: 'Repository Explorer', bodyClass: 'sidebar-view' },
};

export function getLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'ui')];
}

/** HTML for `dist/<entry>.js`, loaded through `asWebviewUri` with a per-render nonce. */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, entry: WebviewEntry): string {
  const page = ENTRY_PAGES[entry];
  return renderWebviewHtml({
    title: page.title,
    bodyClass: page.bodyClass,
    nonce: getNonce(),
    cspSource: webview.cspSource,
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', `${entry}.js`)).toString(),
    stylesUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'ui', 'styles.css')).toString(),
  });
}
