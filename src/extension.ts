import * as vscode from 'vscode';
import { BlameController } from './blame/BlameController';
import { BLAME_HOVER_COMMANDS } from './blame/blameHover';
import { GitBlameService, validateRelativeBlamePath } from './git/gitBlameService';
import {
  GitShowContentProvider,
  normalizeRepoRootPath,
  openCommitFileDiff,
  registerGitShowContentProvider,
} from './git/gitDiffProvider';
import { isValidCommitHash } from './git/gitService';
import { GitRepoPanel, OPEN_REPOSITORY_COMMAND, REFRESH_COMMAND } from './webview/GitRepoPanel';
import { SidebarViewProvider } from './webview/SidebarViewProvider';

function commandPayload(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function activate(context: vscode.ExtensionContext): void {
  const gitDiffProvider = new GitShowContentProvider();
  const coordinator = GitRepoPanel.initialize(context, gitDiffProvider);
  const blameService = new GitBlameService();
  const blameController = new BlameController({
    blameService,
    coordinator,
    extensionUri: context.extensionUri,
  });
  context.subscriptions.push(
    registerGitShowContentProvider(gitDiffProvider),
    blameController,
    vscode.commands.registerCommand(OPEN_REPOSITORY_COMMAND, () => GitRepoPanel.createOrShow(context.extensionUri)),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      GitRepoPanel.refresh();
    }),
    vscode.commands.registerCommand(
      'gitRepoAndBranchExplorer.toggleInlineBlame',
      () => blameController.toggleEnabled(),
    ),
    vscode.commands.registerCommand(
      'gitRepoAndBranchExplorer.toggleFileAnnotate',
      () => blameController.toggleAnnotateForActiveEditor(),
    ),
    vscode.commands.registerCommand(BLAME_HOVER_COMMANDS.revealCommitInTimeline, async (value: unknown) => {
      const payload = commandPayload(value);
      const hash = payload?.hash;
      if (isValidCommitHash(hash)) {
        await GitRepoPanel.revealCommit(context.extensionUri, hash);
      }
    }),
    vscode.commands.registerCommand(BLAME_HOVER_COMMANDS.openBlameFileDiff, async (value: unknown) => {
      if (!vscode.workspace.isTrusted) {
        return;
      }
      const payload = commandPayload(value);
      const activeRepoRoot = coordinator.getActiveRepoRoot();
      if (
        payload === null ||
        activeRepoRoot === null ||
        typeof payload.repoRoot !== 'string' ||
        !isValidCommitHash(payload.hash) ||
        typeof payload.filePath !== 'string'
      ) {
        return;
      }
      try {
        if (normalizeRepoRootPath(payload.repoRoot) !== normalizeRepoRootPath(activeRepoRoot)) {
          return;
        }
        const normalizedFilePath = validateRelativeBlamePath(payload.filePath);
        const previousFilename = payload.previousFilename === undefined
          ? undefined
          : typeof payload.previousFilename === 'string'
            ? validateRelativeBlamePath(payload.previousFilename)
            : undefined;
        if (payload.previousFilename !== undefined && previousFilename === undefined) {
          return;
        }
        await openCommitFileDiff(activeRepoRoot, payload.hash, normalizedFilePath, 'M', previousFilename);
      } catch (err) {
        void vscode.window.showWarningMessage(
          `Could not open the blame diff: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
    vscode.commands.registerCommand(BLAME_HOVER_COMMANDS.copyCommitHash, async (value: unknown) => {
      const hash = commandPayload(value)?.hash;
      if (!isValidCommitHash(hash)) {
        return;
      }
      await vscode.env.clipboard.writeText(hash.toLowerCase());
      vscode.window.setStatusBarMessage(`Copied commit ${hash.slice(0, 8)} to the clipboard.`, 3000);
    }),
    vscode.commands.registerCommand(BLAME_HOVER_COMMANDS.openCommitOnGitHub, async (value: unknown) => {
      const hash = commandPayload(value)?.hash;
      if (!isValidCommitHash(hash)) {
        return;
      }
      if (!(await coordinator.openCommitOnGitHubByHash(hash))) {
        void vscode.window.showWarningMessage('This repository has no GitHub remote to open the commit on.');
      }
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
