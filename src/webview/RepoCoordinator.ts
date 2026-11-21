import * as path from 'path';
import * as vscode from 'vscode';
import type { GitShowContentProvider } from '../git/gitDiffProvider';
import { openCommitFileDiff } from '../git/gitDiffProvider';
import { GitExecutionError, validateGitRef } from '../git/gitExecutor';
import { findGitGraphExtensionId, openInGitGraph } from '../git/gitGraphInterop';
import { GitService, isValidCommitHash } from '../git/gitService';
import type { TrackedFetchResult } from '../git/trackedFetch';
import { describeTrackedFetch, NOTHING_TO_FETCH_MESSAGE, planTrackedFetch } from '../git/trackedFetch';
import { GitHubService } from '../github/githubService';
import type { BranchInfo, ExternalIntegrationsInfo, RepoSnapshot } from '../types/git';
import type {
  ActionStatusPayload,
  ExtensionToWebviewMessage,
  GitAction,
  InitStatePayload,
  OpenFileDiffPayload,
  RepoErrorPayload,
  SyncStatePayload,
  TrackingIndicatorOrder,
} from '../types/messages';
import { isChangedFileStatus, isWebviewToExtensionMessage, MAX_ACTION_STATUS_LENGTH } from '../types/messages';
import type { RefTarget } from './ui/state';
import { isSameSelection, listRefTargets, normalizeSelection } from './ui/state';

/** Git metadata whose changes mean branches, HEAD or remote refs moved outside this panel. */
export const GIT_WATCH_GLOB = '.git/{HEAD,FETCH_HEAD,ORIG_HEAD,packed-refs,refs/**}';
export const GIT_WATCH_DEBOUNCE_MS = 400;
export const WORKSPACE_TRUST_ERROR_MESSAGE =
  'Trust this workspace in VS Code before using Git Repo & Branch Explorer. Git commands are disabled in untrusted workspaces.';

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

function getInitState(
  tabPinned: boolean,
  showCheckedOutBadge: boolean,
  trackingOrder: TrackingIndicatorOrder,
): InitStatePayload {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { repoName: 'No folder open', workspacePath: null, tabPinned, showCheckedOutBadge, trackingOrder };
  }
  const fsPath = folder.uri.fsPath;
  return {
    repoName: folder.name || path.basename(fsPath),
    workspacePath: fsPath,
    tabPinned,
    showCheckedOutBadge,
    trackingOrder,
  };
}

/** Hint appended to failures of operations that can stop half-way through with conflicts. */
function conflictHint(command: string): string {
  return `If Git reported conflicts, resolve them in the Source Control view or run "git ${command} --abort" in a terminal.`;
}

function isNotFullyMergedError(err: unknown): boolean {
  return err instanceof GitExecutionError && /not fully merged/i.test(err.stderr);
}

/** The two webviews the coordinator keeps in step: the Activity Bar branch tree and the editor timeline. */
export type SurfaceId = 'sidebar' | 'editor';

export interface WebviewSurface {
  readonly id: SurfaceId;
  post(message: ExtensionToWebviewMessage): void;
}

/** What the coordinator needs from the code that owns the editor tab and its pin state. */
export interface RepoCoordinatorHost {
  getTabPinned(): boolean;
  setTabPinned(pinned: boolean): void;
  getShowCheckedOutBadge(): boolean;
  /** Stores the preference and tells every connected view (see {@link RepoCoordinator.publishInitState}). */
  setShowCheckedOutBadge(show: boolean): void;
  getTrackingOrder(): TrackingIndicatorOrder;
  setTrackingOrder(order: TrackingIndicatorOrder): void;
  /** Opens or reveals the editor tab. */
  openPanel(): void;
  /** The checked-out branch of the loaded repository (for the tab title), or null when none is loaded. */
  onCurrentBranchChange(currentBranch: string | null): void;
}

const EMPTY_SELECTION: SyncStatePayload = { selectedBranchFullName: null, selectedBranchRef: null, pinnedBranchFullNames: [] };

/**
 * Single owner of the repository snapshot, Git operations, `.git` watcher and the shared ref selection.
 * The sidebar tree and the editor timeline are thin views that attach to it, so neither depends on the
 * other being open and both always render the same snapshot, selection and busy status.
 */
export class RepoCoordinator implements vscode.Disposable {
  private readonly surfaces = new Map<SurfaceId, WebviewSurface>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly gitService = new GitService();
  private readonly githubService = new GitHubService();
  private loadSequence = 0;
  private disposed = false;
  private lastSnapshot: RepoSnapshot | null = null;
  private selection: SyncStatePayload = EMPTY_SELECTION;
  private status: ActionStatusPayload = { busy: false };
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

  constructor(
    private readonly host: RepoCoordinatorHost,
    private readonly gitDiffProvider?: GitShowContentProvider,
  ) {
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshIfAttached(), null, this.disposables);
    vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshIfAttached(), null, this.disposables);
    vscode.extensions.onDidChange(
      () => {
        if (this.surfaces.size > 0 && vscode.workspace.isTrusted) {
          void this.publishIntegrations();
        }
      },
      null,
      this.disposables,
    );
  }

  /** Registers a view; a newer surface with the same id replaces the old one. */
  public attach(surface: WebviewSurface): void {
    this.surfaces.set(surface.id, surface);
  }

  public detach(surface: WebviewSurface): void {
    if (this.surfaces.get(surface.id) !== surface) {
      return;
    }
    this.surfaces.delete(surface.id);
    if (this.surfaces.size === 0) {
      this.release();
    }
  }

  public refresh(): void {
    void this.loadRepository();
  }

  /** Handles an untrusted message from `source`; anything that is not a valid webview message is dropped. */
  public handleMessage(source: SurfaceId, message: unknown): void {
    if (!isWebviewToExtensionMessage(message)) {
      return;
    }
    switch (message.type) {
      case 'webviewReady':
        this.sendInitialState(source);
        break;
      case 'requestRefresh':
        void this.loadRepository();
        break;
      case 'openRepositoryPanel':
        this.host.openPanel();
        break;
      case 'syncState':
        this.applySyncedSelection(source, message.payload);
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
        this.host.setTabPinned(message.payload.pinned);
        break;
      case 'setShowCheckedOutBadge':
        this.host.setShowCheckedOutBadge(message.payload.show);
        break;
      case 'setTrackingOrder':
        this.host.setTrackingOrder(message.payload.order);
        this.publishInitState();
        break;
      case 'copyCommitHash':
        void this.copyCommitHash(message.payload.hash);
        break;
      case 'requestCommitDetails':
        void this.sendCommitDetails(source, message.payload.hash);
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

  public getInitState(): InitStatePayload {
    return getInitState(
      this.host.getTabPinned(),
      this.host.getShowCheckedOutBadge(),
      this.host.getTrackingOrder(),
    );
  }

  /**
   * Pushes changed preferences to every attached view. A webview treats `initState` as the start of a load,
   * so the cached snapshot is re-sent right after to end that loading state.
   */
  public publishInitState(): void {
    this.broadcast({ type: 'initState', payload: this.getInitState() });
    if (this.lastSnapshot !== null) {
      this.broadcast({ type: 'repoSnapshot', payload: this.lastSnapshot });
    }
  }

  /** Brings a freshly loaded webview up to date from the cached state, or loads the repository if there is none yet. */
  private sendInitialState(source: SurfaceId): void {
    const surface = this.surfaces.get(source);
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!surface) {
      return;
    }
    if (snapshot === null) {
      void this.loadRepository();
      return;
    }
    surface.post({ type: 'initState', payload: this.getInitState() });
    this.host.onCurrentBranchChange(snapshot.currentBranch);
    surface.post({ type: 'repoSnapshot', payload: snapshot });
    surface.post({ type: 'syncState', payload: this.selection });
    surface.post({ type: 'integrationsInfo', payload: this.integrations });
    if (this.status.busy) {
      surface.post({ type: 'actionStatus', payload: this.status });
    }
  }

  /**
   * Stores a selection reported by one view and forwards it to the other. The selection is re-validated
   * against the snapshot; when that changes it, the sender is told the corrected value.
   */
  private applySyncedSelection(source: SurfaceId, payload: SyncStatePayload): void {
    const next = normalizeSelection(this.lastSnapshot, payload);
    if (!isSameSelection(next, payload)) {
      this.surfaces.get(source)?.post({ type: 'syncState', payload: next });
    }
    if (isSameSelection(next, this.selection)) {
      return;
    }
    this.selection = next;
    for (const surface of this.surfaces.values()) {
      if (surface.id !== source) {
        surface.post({ type: 'syncState', payload: next });
      }
    }
  }

  private refreshIfAttached(): void {
    if (this.surfaces.size > 0) {
      void this.loadRepository();
    }
  }

  /** No view is showing the repository any more: stop watching it and forget the transient state. */
  private release(): void {
    this.loadSequence++;
    this.lastSnapshot = null;
    this.selection = EMPTY_SELECTION;
    this.gitDiffProvider?.clearAllowedRepoRoots();
    this.disposeGitWatcher();
  }

  private async runGitOperation(
    title: string,
    operation: (repoRoot: string) => Promise<void>,
    failureHint?: string,
  ): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
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
    this.status = message === undefined ? { busy } : { busy, message: message.slice(0, MAX_ACTION_STATUS_LENGTH) };
    this.broadcast({ type: 'actionStatus', payload: this.status });
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
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    switch (action) {
      case 'fetch':
        await this.runGitOperation('Fetching all remotes', (root) => this.gitService.fetchAll(root));
        break;
      case 'fetchTracked':
        await this.handleFetchTracked();
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
      case 'revertMerge':
        await this.handleRevertMerge(target);
        break;
      case 'deleteBranch':
        await this.handleDeleteBranch(target);
        break;
      case 'checkoutRemoteBranch':
        await this.handleCheckoutRemoteBranch(target);
        break;
      case 'resetMixed':
        await this.handleReset(target, 'mixed');
        break;
      case 'resetHard':
        await this.handleReset(target, 'hard');
        break;
    }
  }

  private async handleReset(target: string | undefined, mode: 'mixed' | 'hard'): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || snapshot.isDetachedHead || !snapshot.localBranches.some((branch) => branch.isCurrent)) {
      void vscode.window.showWarningMessage('Check out a branch before resetting the current branch.');
      return;
    }
    if (target === undefined) {
      return;
    }

    const resolved = this.resolveResetTarget(snapshot, target);
    if (!resolved) {
      void vscode.window.showWarningMessage(`"${target}" is not an unambiguous commit or ref in this repository.`);
      return;
    }

    const currentBranch = snapshot.currentBranch;
    const confirmation =
      mode === 'mixed'
        ? `Reset "${currentBranch}" to ${resolved.label}? Commits after this target will be undone, while changes remain unstaged in the working tree.`
        : `Reset "${currentBranch}" to ${resolved.label}? ALL uncommitted changes and commits after this target will be permanently discarded.`;
    const button = mode === 'mixed' ? 'Reset (Keep Changes)' : 'Delete Changes (--hard)';
    const choice = await vscode.window.showWarningMessage(confirmation, { modal: true }, button);
    if (choice !== button) {
      return;
    }
    await this.runGitOperation(
      `${mode === 'mixed' ? 'Resetting and keeping changes in' : 'Hard-resetting'} ${resolved.label}`,
      (root) => this.gitService.resetCurrentBranch(root, resolved.target, mode),
      mode === 'hard' ? 'Review the repository state before continuing.' : undefined,
    );
  }

  private resolveResetTarget(
    snapshot: RepoSnapshot,
    target: string,
  ): { target: string; label: string } | null {
    const normalizedHash = target.toLowerCase();
    const matchingCommit = isValidCommitHash(target)
      ? snapshot.commits.find((commit) => commit.hash === normalizedHash)
      : undefined;

    const refs = [
      ...snapshot.localBranches.map((branch) => ({
        target: branch.fullName,
        names: [branch.name, branch.fullName],
        label: branch.name,
      })),
      ...snapshot.remoteGroups.flatMap((group) =>
        group.branches.map((branch) => ({
          target: branch.fullName,
          names: [branch.name, branch.fullName],
          label: branch.name,
        })),
      ),
      ...snapshot.tags.map((tag) => ({
        target: tag.fullName,
        names: [tag.name, tag.fullName],
        label: tag.name,
      })),
    ].filter((ref) => ref.names.includes(target));

    const resultCount = refs.length + (matchingCommit === undefined ? 0 : 1);
    if (resultCount !== 1) {
      return null;
    }
    if (matchingCommit) {
      return { target: matchingCommit.hash, label: matchingCommit.shortHash };
    }
    return refs[0] ?? null;
  }

  private async handleRevertMerge(hash: string | undefined): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || !hash || !isValidCommitHash(hash)) {
      return;
    }
    if (snapshot.isDetachedHead || !snapshot.localBranches.some((branch) => branch.isCurrent)) {
      void vscode.window.showWarningMessage('Check out a branch before reverting a merge commit.');
      return;
    }
    const commit = snapshot.commits.find((candidate) => candidate.hash === hash.toLowerCase());
    if (!commit || commit.parents.length <= 1) {
      void vscode.window.showWarningMessage('Revert Merge requires a merge commit from the loaded repository history.');
      return;
    }

    const firstParent = commit.parents[0]?.slice(0, 7);
    if (!firstParent) {
      return;
    }
    const button = 'Revert Merge';
    const choice = await vscode.window.showWarningMessage(
      `Revert merge commit ${commit.shortHash} using mainline parent 1 (${firstParent})? ` +
        'This creates a new commit undoing the merged changes while preserving first-parent history.',
      { modal: true },
      button,
    );
    if (choice !== button) {
      return;
    }
    await this.runGitOperation(
      `Reverting merge commit ${commit.shortHash}`,
      (root) => this.gitService.revertMergeCommit(root, commit.hash, 1),
      conflictHint('revert'),
    );
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
    if (current.upstreamGone) {
      void vscode.window.showWarningMessage(`The upstream "${current.upstream}" of "${current.name}" no longer exists on the remote.`);
      return;
    }
    await this.runGitOperation('Pulling', (root) => this.gitService.pullCurrentBranch(root));
  }

  /** Fetches only remotes tracked by local branches; untracked branches are skipped, and the outcome is reported. */
  private async handleFetchTracked(): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    if (planTrackedFetch(snapshot.localBranches, snapshot.remoteGroups).remotes.length === 0) {
      void vscode.window.showInformationMessage(NOTHING_TO_FETCH_MESSAGE);
      return;
    }
    let result = null as TrackedFetchResult | null;
    await this.runGitOperation('Fetching tracked branches', async (root) => {
      result = await this.gitService.fetchTrackedBranches(root, snapshot.localBranches, snapshot.remoteGroups);
    });
    if (result !== null) {
      void vscode.window.showInformationMessage(describeTrackedFetch(result));
    }
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

  private async sendCommitDetails(source: SurfaceId, hash: string): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot || !isValidCommitHash(hash)) {
      return;
    }
    try {
      const details = await this.gitService.getCommitDetails(snapshot.repoRoot, hash);
      this.surfaces.get(source)?.post({ type: 'commitDetails', payload: details });
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not load commit ${hash.slice(0, 8)}: ${describeError(err)}`);
    }
  }

  private async openFileDiff(payload: OpenFileDiffPayload): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
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
    if (!vscode.workspace.isTrusted) {
      this.reportUntrustedWorkspace();
      return;
    }
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
    this.broadcast({ type: 'integrationsInfo', payload: this.integrations });
  }

  private async copyCommitHash(hash: string): Promise<void> {
    await vscode.env.clipboard.writeText(hash);
    vscode.window.setStatusBarMessage(`Copied commit ${hash.slice(0, 8)} to the clipboard.`, 3000);
  }

  private async loadRepository(): Promise<void> {
    if (this.disposed || this.surfaces.size === 0) {
      return;
    }
    const sequence = ++this.loadSequence;
    const initState = this.getInitState();
    this.broadcast({ type: 'initState', payload: initState });
    this.gitDiffProvider?.clearAllowedRepoRoots();

    if (!this.ensureTrustedWorkspace()) {
      return;
    }

    if (initState.workspacePath === null) {
      this.lastSnapshot = null;
      this.updateGitWatcher(null);
      this.host.onCurrentBranchChange(null);
      this.broadcast({
        type: 'repoError',
        payload: { code: 'NO_WORKSPACE', message: 'Open a folder that contains a Git repository.' },
      });
      return;
    }

    try {
      const snapshot = await this.gitService.getRepoSnapshot(initState.workspacePath);
      // Drop results superseded by a newer refresh or arriving after every view closed.
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      this.lastSnapshot = snapshot;
      this.gitDiffProvider?.setAllowedRepoRoots([snapshot.repoRoot]);
      // Each webview reconciles its own selection with the snapshot identically, so no extra sync message is needed.
      this.selection = normalizeSelection(snapshot, this.selection);
      this.updateGitWatcher(snapshot.repoRoot);
      this.host.onCurrentBranchChange(snapshot.currentBranch);
      this.broadcast({ type: 'repoSnapshot', payload: snapshot });
      void this.publishIntegrations();
    } catch (err) {
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      this.lastSnapshot = null;
      this.gitDiffProvider?.clearAllowedRepoRoots();
      this.updateGitWatcher(null);
      this.host.onCurrentBranchChange(null);
      this.broadcast({ type: 'repoError', payload: toRepoErrorPayload(err) });
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

  private ensureTrustedWorkspace(): boolean {
    if (vscode.workspace.isTrusted) {
      return true;
    }
    this.reportUntrustedWorkspace();
    return false;
  }

  private reportUntrustedWorkspace(): void {
    this.loadSequence++;
    this.lastSnapshot = null;
    this.selection = EMPTY_SELECTION;
    this.gitDiffProvider?.clearAllowedRepoRoots();
    this.updateGitWatcher(null);
    this.host.onCurrentBranchChange(null);
    this.broadcast({
      type: 'repoError',
      payload: { code: 'UNTRUSTED_WORKSPACE', message: WORKSPACE_TRUST_ERROR_MESSAGE },
    });
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

  private broadcast(message: ExtensionToWebviewMessage): void {
    for (const surface of this.surfaces.values()) {
      surface.post(message);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.surfaces.clear();
    this.gitDiffProvider?.clearAllowedRepoRoots();
    this.disposeGitWatcher();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
