import * as path from 'path';
import * as vscode from 'vscode';
import { openCommitFileDiff } from '../git/gitDiffProvider';
import { GitExecutionError, validateGitRef } from '../git/gitExecutor';
import { findGitGraphExtensionId, openInGitGraph } from '../git/gitGraphInterop';
import { GitService, isValidCommitHash } from '../git/gitService';
import { GitHubService } from '../github/githubService';
import type { ExternalIntegrationsInfo, RepoSnapshot } from '../types/git';
import type {
  ExtensionToWebviewMessage,
  GitAction,
  InitStatePayload,
  OpenFileDiffPayload,
  RepoErrorPayload,
} from '../types/messages';
import { isChangedFileStatus, isWebviewToExtensionMessage, MAX_ACTION_STATUS_LENGTH } from '../types/messages';
import { buildContentSecurityPolicy, escapeHtml, getNonce } from './security';

export const OPEN_REPOSITORY_COMMAND = 'gitRepoAndBranchExplorer.openRepository';
export const REFRESH_COMMAND = 'gitRepoAndBranchExplorer.refresh';

const PANEL_TITLE = 'Git Repository';

/** Git metadata whose changes mean branches, HEAD or remote refs moved outside this panel. */
export const GIT_WATCH_GLOB = '.git/{HEAD,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**}';
export const GIT_WATCH_DEBOUNCE_MS = 400;

/** Prefers Git's own `fatal:`/`error:` line, since network commands print progress to stderr first. */
function describeError(err: unknown): string {
  if (err instanceof GitExecutionError) {
    const line = err.stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^(fatal|error):/i.test(l));
    return line ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function toRepoErrorPayload(err: unknown): RepoErrorPayload {
  if (err instanceof GitExecutionError) {
    switch (err.code) {
      case 'NOT_A_REPO':
        return { code: err.code, message: 'The open folder is not inside a Git repository.' };
      case 'GIT_NOT_FOUND':
        return { code: err.code, message: 'Git was not found. Install Git and make sure it is on your PATH.' };
      default:
        return { code: err.code, message: err.message };
    }
  }
  return { message: err instanceof Error ? err.message : 'An unknown error occurred while reading the repository.' };
}

function getLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'ui')];
}

function getStylesUri(webview: vscode.Webview, extensionUri: vscode.Uri): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'ui', 'styles.css'));
}

function getInitState(): InitStatePayload {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { repoName: 'No folder open', workspacePath: null };
  }
  const fsPath = folder.uri.fsPath;
  return { repoName: folder.name || path.basename(fsPath), workspacePath: fsPath };
}

/** Singleton editor-area panel, analogous to Visual Studio's "Git Repository" window. */
export class GitRepoPanel {
  public static readonly viewType = 'gitRepoAndBranchExplorer.panel';
  private static currentPanel: GitRepoPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly gitService = new GitService();
  private readonly githubService = new GitHubService();
  private loadSequence = 0;
  private disposed = false;
  private lastSnapshot: RepoSnapshot | null = null;
  private integrations: ExternalIntegrationsInfo = {
    gitGraphAvailable: false,
    gitGraphExtensionId: null,
    githubRemoteUrl: null,
  };
  private operationInProgress = false;
  private gitWatcher: vscode.FileSystemWatcher | undefined;
  private gitWatcherSubscriptions: vscode.Disposable[] = [];
  private watchedRepoRoot: string | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (GitRepoPanel.currentPanel) {
      GitRepoPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(GitRepoPanel.viewType, PANEL_TITLE, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: getLocalResourceRoots(extensionUri),
    });

    GitRepoPanel.currentPanel = new GitRepoPanel(panel, extensionUri);
  }

  public static refresh(): void {
    void GitRepoPanel.currentPanel?.loadRepository();
  }

  public static disposeCurrent(): void {
    GitRepoPanel.currentPanel?.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'git-repo-icon.svg');
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      null,
      this.disposables,
    );
    vscode.workspace.onDidChangeWorkspaceFolders(() => void this.loadRepository(), null, this.disposables);
    vscode.extensions.onDidChange(() => void this.publishIntegrations(), null, this.disposables);
  }

  private handleMessage(message: unknown): void {
    if (!isWebviewToExtensionMessage(message)) {
      return;
    }
    switch (message.type) {
      case 'webviewReady':
      case 'requestRefresh':
        void this.loadRepository();
        break;
      case 'openRepositoryPanel':
        this.panel.reveal();
        break;
      case 'checkoutBranch':
        void this.handleCheckout(message.payload.branchName);
        break;
      case 'gitAction':
        void this.handleGitAction(message.payload.action);
        break;
      case 'copyCommitHash':
        void this.copyCommitHash(message.payload.hash);
        break;
      case 'requestCommitDetails':
        void this.sendCommitDetails(message.payload.hash);
        break;
      case 'openFileDiff':
        void this.openFileDiff(message.payload);
        break;
      case 'openInGitGraph':
        if (this.lastSnapshot) {
          void openInGitGraph(this.lastSnapshot.repoRoot);
        }
        break;
      case 'openCommitOnGitHub':
        void this.openCommitOnGitHub(message.payload.hash);
        break;
      case 'signInGitHub':
        void this.signInGitHub();
        break;
    }
  }

  /** Runs a mutating Git operation with progress UI, then refreshes the snapshot. One at a time. */
  private async runGitOperation(title: string, operation: (repoRoot: string) => Promise<void>): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    if (this.operationInProgress) {
      void vscode.window.showWarningMessage('Another Git operation is already running.');
      return;
    }
    this.operationInProgress = true;
    this.postActionStatus(true, `${title}\u2026`);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => operation(snapshot.repoRoot),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`${title} failed: ${describeError(err)}`);
    } finally {
      this.operationInProgress = false;
      this.postActionStatus(false);
      await this.loadRepository();
    }
  }

  private postActionStatus(busy: boolean, message?: string): void {
    this.post({
      type: 'actionStatus',
      payload: message === undefined ? { busy } : { busy, message: message.slice(0, MAX_ACTION_STATUS_LENGTH) },
    });
  }

  private async handleCheckout(branchName: string): Promise<void> {
    let ref: string;
    try {
      ref = validateGitRef(branchName);
    } catch (err) {
      void vscode.window.showWarningMessage(`Cannot check out branch: ${describeError(err)}`);
      return;
    }
    const branch = this.lastSnapshot?.localBranches.find((b) => b.name === ref);
    if (!branch) {
      void vscode.window.showWarningMessage(`"${ref}" is not a local branch in this repository.`);
      return;
    }
    if (branch.isCurrent) {
      return;
    }
    await this.runGitOperation(`Checking out ${ref}`, (root) => this.gitService.checkoutBranch(root, ref));
  }

  private async handleGitAction(action: GitAction): Promise<void> {
    switch (action) {
      case 'fetch':
        await this.runGitOperation('Fetching all remotes', (root) => this.gitService.fetchAll(root));
        break;
      case 'pull':
        await this.runGitOperation('Pulling', (root) => this.gitService.pullCurrentBranch(root));
        break;
      case 'push':
        await this.handlePush();
        break;
      case 'createBranch':
        await this.handleCreateBranch();
        break;
    }
  }

  private async handlePush(): Promise<void> {
    const snapshot = this.lastSnapshot;
    const current = snapshot?.localBranches.find((b) => b.isCurrent);
    if (!snapshot || !current || snapshot.isDetachedHead) {
      void vscode.window.showWarningMessage('Check out a branch before pushing.');
      return;
    }
    const hasUpstream = current.upstream !== null;
    if (!hasUpstream) {
      if (!snapshot.remoteGroups.some((g) => g.remoteName === 'origin')) {
        void vscode.window.showWarningMessage(`"${current.name}" has no upstream and this repository has no "origin" remote.`);
        return;
      }
      const publish = 'Publish Branch';
      const choice = await vscode.window.showInformationMessage(
        `"${current.name}" has no upstream branch. Publish it to "origin/${current.name}"?`,
        { modal: true },
        publish,
      );
      if (choice !== publish) {
        return;
      }
    }
    const title = hasUpstream ? `Pushing ${current.name}` : `Publishing ${current.name} to origin`;
    await this.runGitOperation(title, (root) => this.gitService.pushCurrentBranch(root, current.name, hasUpstream));
  }

  private async handleCreateBranch(): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    const existing = new Set(snapshot.localBranches.map((b) => b.name));
    const input = await vscode.window.showInputBox({
      title: 'Create New Branch',
      prompt: `New branch from ${snapshot.currentBranch}`,
      placeHolder: 'feature/my-branch',
      validateInput: (value) => {
        if (value.trim().length === 0) {
          return 'Enter a branch name.';
        }
        try {
          const ref = validateGitRef(value);
          return existing.has(ref) ? `A branch named "${ref}" already exists.` : null;
        } catch (err) {
          return describeError(err);
        }
      },
    });
    if (input === undefined) {
      return;
    }
    const name = validateGitRef(input);
    await this.runGitOperation(`Creating branch ${name}`, (root) => this.gitService.createBranch(root, name));
  }

  private async sendCommitDetails(hash: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || !isValidCommitHash(hash)) {
      return;
    }
    try {
      const details = await this.gitService.getCommitDetails(snapshot.repoRoot, hash);
      this.post({ type: 'commitDetails', payload: details });
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not load commit ${hash.slice(0, 8)}: ${describeError(err)}`);
    }
  }

  private async openFileDiff(payload: OpenFileDiffPayload): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || !isValidCommitHash(payload.hash) || !isChangedFileStatus(payload.status)) {
      return;
    }
    try {
      await openCommitFileDiff(snapshot.repoRoot, payload.hash, payload.filePath, payload.status, payload.oldPath);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open diff: ${describeError(err)}`);
    }
  }

  private async openCommitOnGitHub(hash: string): Promise<void> {
    const url = this.integrations.githubRemoteUrl;
    if (url === null || !(await this.githubService.openCommit(url, hash))) {
      void vscode.window.showWarningMessage('This repository has no GitHub remote to open the commit on.');
    }
  }

  private async signInGitHub(): Promise<void> {
    const account = await this.githubService.signIn();
    if (account !== null) {
      void vscode.window.showInformationMessage(`Signed in to GitHub as ${account}.`);
    }
  }

  private async publishIntegrations(): Promise<void> {
    const repoRoot = this.lastSnapshot?.repoRoot;
    let githubRemoteUrl: string | null = null;
    if (repoRoot) {
      try {
        githubRemoteUrl = await this.gitService.getGitHubRemoteUrl(repoRoot);
      } catch {
        githubRemoteUrl = null;
      }
    }
    if (repoRoot !== this.lastSnapshot?.repoRoot) {
      return;
    }
    const gitGraphExtensionId = findGitGraphExtensionId();
    this.integrations = { gitGraphAvailable: gitGraphExtensionId !== null, gitGraphExtensionId, githubRemoteUrl };
    this.post({ type: 'integrationsInfo', payload: this.integrations });
  }

  private async copyCommitHash(hash: string): Promise<void> {
    await vscode.env.clipboard.writeText(hash);
    vscode.window.setStatusBarMessage(`Copied commit ${hash.slice(0, 8)} to the clipboard.`, 3000);
  }

  private async loadRepository(): Promise<void> {
    const sequence = ++this.loadSequence;
    const initState = getInitState();
    this.post({ type: 'initState', payload: initState });

    if (initState.workspacePath === null) {
      this.lastSnapshot = null;
      this.updateGitWatcher(null);
      this.panel.title = PANEL_TITLE;
      this.post({
        type: 'repoError',
        payload: { code: 'NO_WORKSPACE', message: 'Open a folder that contains a Git repository.' },
      });
      return;
    }

    try {
      const snapshot = await this.gitService.getRepoSnapshot(initState.workspacePath);
      // Drop results superseded by a newer refresh or arriving after the panel closed.
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      this.lastSnapshot = snapshot;
      this.updateGitWatcher(snapshot.repoRoot);
      this.panel.title = `${PANEL_TITLE} (${snapshot.currentBranch})`;
      this.post({ type: 'repoSnapshot', payload: snapshot });
      void this.publishIntegrations();
    } catch (err) {
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      this.lastSnapshot = null;
      this.updateGitWatcher(null);
      this.panel.title = PANEL_TITLE;
      this.post({ type: 'repoError', payload: toRepoErrorPayload(err) });
    }
  }

  /** (Re)creates the `.git` watcher only when the repository root actually changes. */
  private updateGitWatcher(repoRoot: string | null): void {
    if (repoRoot === this.watchedRepoRoot) {
      return;
    }
    this.disposeGitWatcher();
    if (repoRoot === null || this.disposed) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoRoot, GIT_WATCH_GLOB));
    const onEvent = (uri: vscode.Uri): void => this.onGitMetadataChanged(uri);
    this.gitWatcherSubscriptions = [watcher.onDidCreate(onEvent), watcher.onDidChange(onEvent), watcher.onDidDelete(onEvent)];
    this.gitWatcher = watcher;
    this.watchedRepoRoot = repoRoot;
  }

  private onGitMetadataChanged(uri: vscode.Uri): void {
    // Git writes refs via `<name>.lock` then renames; only the final rename is a meaningful change.
    if (this.disposed || uri.fsPath.endsWith('.lock')) {
      return;
    }
    this.clearWatchDebounce();
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = undefined;
      // A panel-initiated operation refreshes itself when it finishes.
      if (!this.disposed && !this.operationInProgress) {
        void this.loadRepository();
      }
    }, GIT_WATCH_DEBOUNCE_MS);
  }

  private clearWatchDebounce(): void {
    if (this.watchDebounceTimer !== undefined) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }
  }

  private disposeGitWatcher(): void {
    this.clearWatchDebounce();
    for (const subscription of this.gitWatcherSubscriptions) {
      subscription.dispose();
    }
    this.gitWatcherSubscriptions = [];
    this.gitWatcher?.dispose();
    this.gitWatcher = undefined;
    this.watchedRepoRoot = null;
  }

  private post(message: ExtensionToWebviewMessage): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeGitWatcher();
    if (GitRepoPanel.currentPanel === this) {
      GitRepoPanel.currentPanel = undefined;
    }
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const stylesUri = getStylesUri(webview, this.extensionUri);
    const csp = buildContentSecurityPolicy(webview.cspSource, nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${stylesUri.toString()}" rel="stylesheet">
  <title>${PANEL_TITLE}</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

/**
 * Opens the editor-area panel and collapses the now-redundant launcher sidebar, leaving the
 * Visual Studio-style full-width two-pane layout (branch tree | graph & history).
 */
function openPanelAndCollapseSidebar(): void {
  void Promise.resolve(vscode.commands.executeCommand(OPEN_REPOSITORY_COMMAND)).then(() =>
    vscode.commands.executeCommand('workbench.action.closeSidebar'),
  );
}

/** Activity Bar sidebar view that launches the editor-area panel. */
export class SidebarLauncherProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'gitRepoAndBranchExplorer.launcher';

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getLocalResourceRoots(this.extensionUri),
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const subscriptions: vscode.Disposable[] = [
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        if (isWebviewToExtensionMessage(message) && message.type === 'openRepositoryPanel') {
          openPanelAndCollapseSidebar();
        }
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          openPanelAndCollapseSidebar();
        }
      }),
    ];
    webviewView.onDidDispose(() => subscriptions.forEach((d) => d.dispose()));

    // Clicking the Activity Bar icon resolves/reveals this view; open the main panel automatically.
    openPanelAndCollapseSidebar();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const stylesUri = getStylesUri(webview, this.extensionUri);
    const csp = buildContentSecurityPolicy(webview.cspSource, nonce);
    const label = escapeHtml('Open Git Repository Explorer');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${stylesUri.toString()}" rel="stylesheet">
  <title>Repository Explorer</title>
</head>
<body class="launcher">
  <p class="launcher-hint">Browse branches, remotes, and commit history in a dedicated editor tab.</p>
  <button id="open-repo" class="primary-button" type="button">${label}</button>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      document.getElementById('open-repo').addEventListener('click', function () {
        vscode.postMessage({ type: 'openRepositoryPanel' });
      });
    })();
  </script>
</body>
</html>`;
  }
}
