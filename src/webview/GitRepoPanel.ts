import * as path from 'path';
import * as vscode from 'vscode';
import { openCommitFileDiff } from '../git/gitDiffProvider';
import { GitExecutionError, validateGitRef } from '../git/gitExecutor';
import { findGitGraphExtensionId, openInGitGraph } from '../git/gitGraphInterop';
import { GitService, isValidCommitHash } from '../git/gitService';
import { GitHubService } from '../github/githubService';
import type { BranchInfo, ExternalIntegrationsInfo, RepoSnapshot } from '../types/git';
import type {
  ExtensionToWebviewMessage,
  GitAction,
  InitStatePayload,
  OpenFileDiffPayload,
  RepoErrorPayload,
} from '../types/messages';
import { isChangedFileStatus, isWebviewToExtensionMessage, MAX_ACTION_STATUS_LENGTH } from '../types/messages';
import { AUTO_CLOSE_DELAY_MS, shouldAutoClosePanel } from './panelLifecycle';
import { buildContentSecurityPolicy, escapeHtml, getNonce } from './security';
import type { RefTarget } from './ui/state';
import { listRefTargets } from './ui/state';

export const OPEN_REPOSITORY_COMMAND = 'gitRepoAndBranchExplorer.openRepository';
export const REFRESH_COMMAND = 'gitRepoAndBranchExplorer.refresh';
/** Built-in command that selects (and, if needed, shows) this extension's Activity Bar container. */
export const SHOW_CONTAINER_COMMAND = 'workbench.view.extension.gitRepoAndBranchExplorer-container';
const TAB_PINNED_KEY = 'gitRepoAndBranchExplorer.tabPinned';
const MOVE_TO_FIRST_TAB_TIMEOUT_MS = 1500;

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

function getInitState(tabPinned: boolean): InitStatePayload {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { repoName: 'No folder open', workspacePath: null, tabPinned };
  }
  const fsPath = folder.uri.fsPath;
  return { repoName: folder.name || path.basename(fsPath), workspacePath: fsPath, tabPinned };
}

/** Hint appended to failures of operations that can stop half-way through with conflicts. */
function conflictHint(command: string): string {
  return `If Git reported conflicts, resolve them in the Source Control view or run "git ${command} --abort" in a terminal.`;
}

function isNotFullyMergedError(err: unknown): boolean {
  return err instanceof GitExecutionError && /not fully merged/i.test(err.stderr);
}

/** Singleton editor-area panel, analogous to Visual Studio's "Git Repository" window. */
export class GitRepoPanel {
  public static readonly viewType = 'gitRepoAndBranchExplorer.panel';
  private static currentPanel: GitRepoPanel | undefined;
  private static pinStore: vscode.Memento | undefined;
  private static tabPinned = false;
  private static launcherVisible = false;
  private static opening = false;
  private static autoCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private static autoCloseDeferred = false;

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

  /** Restores the persisted pin and watches window focus so a deferred auto-close can still happen. */
  public static initialize(store: vscode.Memento): vscode.Disposable {
    GitRepoPanel.pinStore = store;
    GitRepoPanel.tabPinned = store.get<boolean>(TAB_PINNED_KEY, false);
    return vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused && GitRepoPanel.autoCloseDeferred) {
        GitRepoPanel.autoCloseDeferred = false;
        GitRepoPanel.scheduleAutoClose();
      }
    });
  }

  /**
   * Opens (or reveals) the panel, moves its tab to the far left and makes sure this extension's Activity Bar
   * container is the selected one, so unpinned-tab auto-close tracks the container the user is looking at.
   */
  public static async createOrShow(extensionUri: vscode.Uri): Promise<void> {
    if (GitRepoPanel.opening) {
      return;
    }
    GitRepoPanel.opening = true;
    GitRepoPanel.cancelAutoClose();
    try {
      const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
      let instance = GitRepoPanel.currentPanel;

      if (instance) {
        instance.panel.reveal(instance.panel.viewColumn ?? column);
      } else {
        const panel = vscode.window.createWebviewPanel(GitRepoPanel.viewType, PANEL_TITLE, column, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: getLocalResourceRoots(extensionUri),
        });
        instance = new GitRepoPanel(panel, extensionUri);
        GitRepoPanel.currentPanel = instance;
      }

      await instance.moveToFirstTab();
      await GitRepoPanel.ensureContainerSelected(instance);
    } finally {
      GitRepoPanel.opening = false;
    }
  }

  /** Called by the launcher view whenever it becomes visible or hidden. */
  public static setLauncherVisible(visible: boolean): void {
    GitRepoPanel.launcherVisible = visible;
    if (visible) {
      GitRepoPanel.cancelAutoClose();
    } else {
      GitRepoPanel.scheduleAutoClose();
    }
  }

  public static isTabPinned(): boolean {
    return GitRepoPanel.tabPinned;
  }

  public static setTabPinned(pinned: boolean): void {
    GitRepoPanel.tabPinned = pinned;
    void GitRepoPanel.pinStore?.update(TAB_PINNED_KEY, pinned);
    if (pinned) {
      GitRepoPanel.cancelAutoClose();
    }
  }

  public static refresh(): void {
    void GitRepoPanel.currentPanel?.loadRepository();
  }

  public static disposeCurrent(): void {
    GitRepoPanel.cancelAutoClose();
    GitRepoPanel.currentPanel?.dispose();
  }

  private static async ensureContainerSelected(instance: GitRepoPanel): Promise<void> {
    if (GitRepoPanel.launcherVisible) {
      return;
    }
    try {
      await vscode.commands.executeCommand(SHOW_CONTAINER_COMMAND);
      // Selecting the container focuses its view; hand focus back to the panel the user asked for.
      if (!instance.disposed) {
        instance.panel.reveal(instance.panel.viewColumn);
      }
    } catch {
      // The Activity Bar indicator is cosmetic; never let it prevent the panel from opening.
    }
  }

  private static scheduleAutoClose(): void {
    GitRepoPanel.cancelAutoClose();
    if (!GitRepoPanel.currentPanel) {
      return;
    }
    GitRepoPanel.autoCloseTimer = setTimeout(() => {
      GitRepoPanel.autoCloseTimer = undefined;
      const windowFocused = vscode.window.state.focused;
      if (!windowFocused) {
        GitRepoPanel.autoCloseDeferred = true;
        return;
      }
      const shouldClose = shouldAutoClosePanel({
        tabPinned: GitRepoPanel.tabPinned,
        panelOpening: GitRepoPanel.opening,
        windowFocused,
        launcherVisible: GitRepoPanel.launcherVisible,
      });
      if (shouldClose) {
        GitRepoPanel.currentPanel?.dispose();
      }
    }, AUTO_CLOSE_DELAY_MS);
  }

  private static cancelAutoClose(): void {
    if (GitRepoPanel.autoCloseTimer !== undefined) {
      clearTimeout(GitRepoPanel.autoCloseTimer);
      GitRepoPanel.autoCloseTimer = undefined;
    }
    GitRepoPanel.autoCloseDeferred = false;
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

  /** Moves the panel's tab to the far left of its group, but only while it really is the active editor. */
  private async moveToFirstTab(): Promise<void> {
    if (!this.panel.active) {
      await new Promise<void>((resolve) => {
        const subscription = this.panel.onDidChangeViewState((event) => {
          if (event.webviewPanel.active) {
            finish();
          }
        });
        const timer = setTimeout(finish, MOVE_TO_FIRST_TAB_TIMEOUT_MS);
        function finish(): void {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        }
        if (this.panel.active) {
          finish();
        }
      });
    }
    if (this.disposed || !this.panel.active) {
      return;
    }
    try {
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'first', by: 'tab' });
    } catch {
      // Tab placement is a nicety; the panel is still usable where it is.
    }
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
        void this.handleGitAction(message.payload.action, message.payload.target);
        break;
      case 'createBranchAtRef':
        void this.handleCreateBranch(message.payload.startPoint);
        break;
      case 'setTabPinned':
        GitRepoPanel.setTabPinned(message.payload.pinned);
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
  private async runGitOperation(
    title: string,
    operation: (repoRoot: string) => Promise<void>,
    failureHint?: string,
  ): Promise<void> {
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
      void vscode.window.showErrorMessage(
        `${title} failed: ${describeError(err)}${failureHint === undefined ? '' : ` ${failureHint}`}`,
      );
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

  private async handleGitAction(action: GitAction, target?: string): Promise<void> {
    switch (action) {
      case 'fetch':
        await this.runGitOperation('Fetching all remotes', (root) => this.gitService.fetchAll(root));
        break;
      case 'pull':
        await this.handlePull();
        break;
      case 'push':
        await this.handlePush();
        break;
      case 'createBranch':
        await this.handleCreateBranch();
        break;
      case 'merge':
        await this.handleMerge(target);
        break;
      case 'rebase':
        await this.handleRebase(target);
        break;
      case 'cherryPick':
      case 'revert':
        await this.handleCommitOperation(action, target);
        break;
      case 'deleteBranch':
        await this.handleDeleteBranch(target);
        break;
      case 'checkoutRemoteBranch':
        await this.handleCheckoutRemoteBranch(target);
        break;
    }
  }

  /** Resolves a webview-supplied name to a branch/tag of the loaded snapshot, warning when it is not one. */
  private resolveRef(name: string | undefined, kinds: ReadonlyArray<RefTarget['kind']>): RefTarget | null {
    const snapshot = this.lastSnapshot;
    if (!snapshot || name === undefined) {
      return null;
    }
    let ref: string;
    try {
      ref = validateGitRef(name);
    } catch (err) {
      void vscode.window.showWarningMessage(`Invalid ref: ${describeError(err)}`);
      return null;
    }
    const found = listRefTargets(snapshot).find((target) => target.name === ref && kinds.includes(target.kind));
    if (!found) {
      void vscode.window.showWarningMessage(`"${ref}" is not a known ${kinds.join('/')} ref in this repository.`);
      return null;
    }
    return found;
  }

  /** The checked-out branch, or null (with a warning) when HEAD is detached or unborn. */
  private requireCurrentBranch(action: string): BranchInfo | null {
    const snapshot = this.lastSnapshot;
    const current = snapshot?.localBranches.find((b) => b.isCurrent);
    if (!snapshot || snapshot.isDetachedHead || !current) {
      void vscode.window.showWarningMessage(`Check out a branch before ${action}.`);
      return null;
    }
    return current;
  }

  private async handlePull(): Promise<void> {
    const current = this.requireCurrentBranch('pulling');
    if (!current) {
      return;
    }
    if (current.upstream === null) {
      void vscode.window.showWarningMessage(`"${current.name}" has no upstream branch to pull from.`);
      return;
    }
    await this.runGitOperation('Pulling', (root) => this.gitService.pullCurrentBranch(root));
  }

  private async handleMerge(refName: string | undefined): Promise<void> {
    const target = this.resolveRef(refName, ['local', 'remote', 'tag']);
    const current = target ? this.requireCurrentBranch('merging') : null;
    if (!target || !current) {
      return;
    }
    if (target.kind === 'local' && target.name === current.name) {
      void vscode.window.showWarningMessage('A branch cannot be merged into itself.');
      return;
    }
    await this.runGitOperation(
      `Merging ${target.name} into ${current.name}`,
      (root) => this.gitService.mergeBranch(root, target.name),
      conflictHint('merge'),
    );
  }

  private async handleRebase(refName: string | undefined): Promise<void> {
    const target = this.resolveRef(refName, ['local', 'remote', 'tag']);
    const current = target ? this.requireCurrentBranch('rebasing') : null;
    if (!target || !current) {
      return;
    }
    if (target.kind === 'local' && target.name === current.name) {
      void vscode.window.showWarningMessage('A branch cannot be rebased onto itself.');
      return;
    }
    const rebase = 'Rebase';
    const choice = await vscode.window.showWarningMessage(
      `Rebase "${current.name}" onto "${target.name}"? This rewrites the commits of "${current.name}".`,
      { modal: true },
      rebase,
    );
    if (choice !== rebase) {
      return;
    }
    await this.runGitOperation(
      `Rebasing ${current.name} onto ${target.name}`,
      (root) => this.gitService.rebaseOnto(root, target.name),
      conflictHint('rebase'),
    );
  }

  private async handleCommitOperation(action: 'cherryPick' | 'revert', hash: string | undefined): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || hash === undefined || !isValidCommitHash(hash)) {
      return;
    }
    const lower = hash.toLowerCase();
    const commit = snapshot.commits.find((c) => c.hash === lower);
    if (!commit) {
      void vscode.window.showWarningMessage('That commit is not part of the loaded history.');
      return;
    }
    if (commit.parents.length > 1) {
      void vscode.window.showWarningMessage('Merge commits cannot be cherry-picked or reverted from this view.');
      return;
    }
    if (action === 'cherryPick') {
      await this.runGitOperation(
        `Cherry-picking ${commit.shortHash}`,
        (root) => this.gitService.cherryPickCommit(root, lower),
        conflictHint('cherry-pick'),
      );
    } else {
      await this.runGitOperation(
        `Reverting ${commit.shortHash}`,
        (root) => this.gitService.revertCommit(root, lower),
        conflictHint('revert'),
      );
    }
  }

  private async handleDeleteBranch(branchName: string | undefined): Promise<void> {
    const target = this.resolveRef(branchName, ['local']);
    if (!target) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (snapshot?.isDetachedHead || target.branch?.isCurrent) {
      void vscode.window.showWarningMessage(
        target.branch?.isCurrent ? 'The checked-out branch cannot be deleted.' : 'Check out a branch before deleting branches.',
      );
      return;
    }
    const deleteLabel = 'Delete';
    const choice = await vscode.window.showWarningMessage(`Delete local branch "${target.name}"?`, { modal: true }, deleteLabel);
    if (choice !== deleteLabel) {
      return;
    }
    let needsForce = false as boolean;
    await this.runGitOperation(`Deleting branch ${target.name}`, async (root) => {
      try {
        await this.gitService.deleteLocalBranch(root, target.name);
      } catch (err) {
        if (!isNotFullyMergedError(err)) {
          throw err;
        }
        needsForce = true;
      }
    });
    if (!needsForce) {
      return;
    }
    const force = 'Force Delete';
    const forceChoice = await vscode.window.showWarningMessage(
      `"${target.name}" is not fully merged. Force-delete it and lose its unmerged commits?`,
      { modal: true },
      force,
    );
    if (forceChoice === force) {
      await this.runGitOperation(`Force-deleting branch ${target.name}`, (root) =>
        this.gitService.deleteLocalBranch(root, target.name, true),
      );
    }
  }

  private async handleCheckoutRemoteBranch(remoteBranchName: string | undefined): Promise<void> {
    const snapshot = this.lastSnapshot;
    const target = this.resolveRef(remoteBranchName, ['remote']);
    if (!snapshot || !target || !target.branch) {
      return;
    }
    const existing = new Set(snapshot.localBranches.map((b) => b.name));
    const input = await vscode.window.showInputBox({
      title: 'Check Out as Local Tracking Branch',
      prompt: `Local branch that will track ${target.name}`,
      value: target.branch.displayName,
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
    const localName = validateGitRef(input);
    await this.runGitOperation(`Checking out ${target.name} as ${localName}`, (root) =>
      this.gitService.checkoutRemoteBranch(root, target.name, localName),
    );
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

  /** Creates and checks out a branch from HEAD, or from `startPoint` (a full commit hash or a known ref name). */
  private async handleCreateBranch(startPoint?: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    let startRef: string | undefined;
    let startLabel = snapshot.currentBranch;
    if (startPoint !== undefined) {
      if (isValidCommitHash(startPoint)) {
        const hash = startPoint.toLowerCase();
        if (!snapshot.commits.some((c) => c.hash === hash)) {
          void vscode.window.showWarningMessage('That commit is not part of the loaded history.');
          return;
        }
        startRef = hash;
        startLabel = hash.slice(0, 8);
      } else {
        const target = this.resolveRef(startPoint, ['local', 'remote', 'tag']);
        if (!target) {
          return;
        }
        startRef = target.name;
        startLabel = target.name;
      }
    }
    const existing = new Set(snapshot.localBranches.map((b) => b.name));
    const input = await vscode.window.showInputBox({
      title: 'Create New Branch',
      prompt: `New branch from ${startLabel}`,
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
    await this.runGitOperation(`Creating branch ${name}`, (root) => this.gitService.createBranch(root, name, startRef));
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
    const initState = getInitState(GitRepoPanel.tabPinned);
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
      GitRepoPanel.cancelAutoClose();
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
 * Opens the editor-area panel from the Activity Bar launcher. The sidebar is deliberately left open: the
 * Activity Bar only shows this extension's icon as active while its container is the visible one.
 */
function openPanelFromLauncher(): void {
  void Promise.resolve(vscode.commands.executeCommand(OPEN_REPOSITORY_COMMAND));
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
          openPanelFromLauncher();
        }
      }),
      webviewView.onDidChangeVisibility(() => {
        GitRepoPanel.setLauncherVisible(webviewView.visible);
        if (webviewView.visible) {
          openPanelFromLauncher();
        }
      }),
    ];
    webviewView.onDidDispose(() => {
      subscriptions.forEach((d) => d.dispose());
      GitRepoPanel.setLauncherVisible(false);
    });

    // Clicking the Activity Bar icon resolves/reveals this view; open the main panel automatically.
    GitRepoPanel.setLauncherVisible(webviewView.visible);
    openPanelFromLauncher();
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
  <p class="launcher-hint">Browse branches, remotes, and commit history in a dedicated editor tab. Pin the tab to keep it open while you use other sidebar views.</p>
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
