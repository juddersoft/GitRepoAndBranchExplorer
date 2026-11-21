import * as vscode from 'vscode';
import { GitRepoPanel, OPEN_REPOSITORY_COMMAND } from './GitRepoPanel';
import type { RepoCoordinator, WebviewSurface } from './RepoCoordinator';
import { getLocalResourceRoots, getWebviewHtml } from './webviewResources';

/** Activity Bar view that renders the Branch / Remote / Tag tree and opens the timeline in the editor area. */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'gitRepoAndBranchExplorer.launcher';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly coordinator: RepoCoordinator,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    let disposed = false;
    const surface: WebviewSurface = {
      id: 'sidebar',
      post: (message) => {
        if (!disposed) {
          void webviewView.webview.postMessage(message);
        }
      },
    };
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getLocalResourceRoots(this.extensionUri),
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri, 'sidebar');

    const subscriptions: vscode.Disposable[] = [
      webviewView.webview.onDidReceiveMessage((message: unknown) => this.coordinator.handleMessage('sidebar', message)),
      webviewView.onDidChangeVisibility(() => {
        GitRepoPanel.setSidebarVisible(webviewView.visible);
        if (webviewView.visible) {
          openPanel();
        }
      }),
    ];
    webviewView.onDidDispose(() => {
      disposed = true;
      subscriptions.forEach((d) => d.dispose());
      this.coordinator.detach(surface);
      GitRepoPanel.setSidebarVisible(false);
    });

    this.coordinator.attach(surface);
    // Clicking the Activity Bar icon resolves/reveals this view; open the timeline tab automatically.
    GitRepoPanel.setSidebarVisible(webviewView.visible);
    openPanel();
  }
}

/**
 * Opens the editor-area timeline next to the tree. The sidebar is deliberately left open (no
 * `workbench.action.closeSidebar`): the Activity Bar only shows this extension's icon as active while its
 * container is the visible one.
 */
function openPanel(): void {
  void Promise.resolve(vscode.commands.executeCommand(OPEN_REPOSITORY_COMMAND));
}
