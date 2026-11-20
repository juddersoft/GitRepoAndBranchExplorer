import * as vscode from 'vscode';
import { registerGitShowContentProvider } from './git/gitDiffProvider';
import { GitRepoPanel, OPEN_REPOSITORY_COMMAND, REFRESH_COMMAND, SidebarLauncherProvider } from './webview/GitRepoPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    registerGitShowContentProvider(),
    vscode.commands.registerCommand(OPEN_REPOSITORY_COMMAND, () => {
      GitRepoPanel.createOrShow(context.extensionUri);
    }),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      GitRepoPanel.refresh();
    }),
    vscode.window.registerWebviewViewProvider(
      SidebarLauncherProvider.viewId,
      new SidebarLauncherProvider(context.extensionUri),
    ),
    { dispose: () => GitRepoPanel.disposeCurrent() },
  );
}

export function deactivate(): void {
  GitRepoPanel.disposeCurrent();
}
