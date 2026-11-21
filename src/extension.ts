import * as vscode from 'vscode';
import { GitShowContentProvider, registerGitShowContentProvider } from './git/gitDiffProvider';
import { GitRepoPanel, OPEN_REPOSITORY_COMMAND, REFRESH_COMMAND } from './webview/GitRepoPanel';
import { SidebarViewProvider } from './webview/SidebarViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const gitDiffProvider = new GitShowContentProvider();
  const coordinator = GitRepoPanel.initialize(context, gitDiffProvider);
  context.subscriptions.push(
    registerGitShowContentProvider(gitDiffProvider),
    vscode.commands.registerCommand(OPEN_REPOSITORY_COMMAND, () => GitRepoPanel.createOrShow(context.extensionUri)),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      GitRepoPanel.refresh();
    }),
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewId,
      new SidebarViewProvider(context.extensionUri, coordinator),
      // Keeps the tree (scroll, focus, filter) alive while another sidebar view is selected.
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    { dispose: () => GitRepoPanel.disposeCurrent() },
  );
}

export function deactivate(): void {
  GitRepoPanel.disposeCurrent();
}
