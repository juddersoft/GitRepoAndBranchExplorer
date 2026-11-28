import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GitShowContentProvider } from '../git/gitDiffProvider';
import { buildShowUri, normalizeRepoRootPath, openCommitFileDiff } from '../git/gitDiffProvider';
import { GitExecutionError, validateGitRef } from '../git/gitExecutor';
import { CloneDiscoveryService } from '../git/cloneDiscoveryService';
import { findGitGraphExtensionId, openInGitGraph } from '../git/gitGraphInterop';
import { canonicalizeRepoPath, discoverWorkspaceRepositories } from '../git/repoDiscovery';
import { GitService, isValidCommitHash } from '../git/gitService';
import {
  buildRemoteBranchUrl,
  buildRemoteCommitUrl,
  buildRemoteCreatePrUrl,
  buildRemoteRepoUrl,
  classifyRemoteDestination,
  isDefaultBranchName,
  isUpstreamMismatchError,
  extractCloneFolderName,
  parseRemoteHostInfo,
  parseUpstreamRef,
  resolveGitHubEnterpriseApiBaseUrl,
  validateCloneFolderName,
  validateCloneUrl,
  validateGitHubRepoName,
  validateLocalBareRepoFolderName,
} from '../git/remoteUrlBuilder';
import type { ParsedRemoteHost } from '../git/remoteUrlBuilder';
import type { TrackedFetchResult } from '../git/trackedFetch';
import { describeTrackedFetch, NOTHING_TO_FETCH_MESSAGE, planTrackedFetch } from '../git/trackedFetch';
import { GitHubService } from '../github/githubService';
import type { BranchInfo, ExternalIntegrationsInfo, FileHistoryResult, RepoSnapshot, WorkingTreeFile, WorkspaceRepoInfo } from '../types/git';
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
import {
  isChangedFileStatus,
  isSafeRepoRelativePath,
  isWebviewToExtensionMessage,
  MAX_ACTION_STATUS_LENGTH,
} from '../types/messages';
import type { RefTarget } from './ui/state';
import { isSameSelection, listRefTargets, normalizeSelection } from './ui/state';
import type { CreateBranchDialogRequest, CreateBranchSourceKind } from './ui/branchCreateModel';
import { extractShortRemoteBranchName } from './ui/branchCreateModel';
import type { CreateWorktreeDialogPayload } from './ui/worktreeCreateModel';

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
  showFolderCounts: boolean,
  trackingOrder: TrackingIndicatorOrder,
): InitStatePayload {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return {
      repoName: 'No folder open',
      workspacePath: null,
      tabPinned,
      showCheckedOutBadge,
      showFolderCounts,
      trackingOrder,
    };
  }
  const fsPath = folder.uri.fsPath;
  return {
    repoName: folder.name || path.basename(fsPath),
    workspacePath: fsPath,
    tabPinned,
    showCheckedOutBadge,
    showFolderCounts,
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

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value);
}

function resolveWorktreePath(value: string): string {
  return (process.platform === 'win32' || isWindowsStylePath(value) ? path.win32 : path.posix).resolve(value);
}

function isAbsoluteWorktreePath(value: string): boolean {
  return (process.platform === 'win32' || isWindowsStylePath(value) ? path.win32 : path.posix).isAbsolute(value);
}

function normalizeWorktreePathForComparison(value: string): string {
  const windowsPath = process.platform === 'win32' || isWindowsStylePath(value);
  const resolved = (windowsPath ? path.win32 : path.posix).resolve(value).replace(/\\/g, '/');
  return windowsPath ? resolved.toLowerCase() : resolved;
}

/** The two webviews the coordinator keeps in step: the Activity Bar branch tree and the editor timeline. */
export type SurfaceId = 'sidebar' | 'editor';

export type DirtyWorktreeAction = 'bring' | 'stash' | 'discard' | 'leaveInWorktree' | 'cancel';

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
  getShowFolderCounts(): boolean;
  setShowFolderCounts(show: boolean): void;
  getTrackingOrder(): TrackingIndicatorOrder;
  setTrackingOrder(order: TrackingIndicatorOrder): void;
  /** Opens or reveals the editor tab. */
  openPanel(): void;
  /** The checked-out branch of the loaded repository (for the tab title), or null when none is loaded. */
  onCurrentBranchChange(currentBranch: string | null): void;
}

export interface RepoCoordinatorDependencies {
  readonly gitService?: GitService;
  readonly githubService?: GitHubService;
  readonly cloneDiscoveryService?: CloneDiscoveryService;
}

const EMPTY_SELECTION: SyncStatePayload = { selectedBranchFullName: null, selectedBranchRef: null, pinnedBranchFullNames: [] };
const MAX_REVEAL_SEARCH_PAGES = 10;

/**
 * Single owner of the repository snapshot, Git operations, `.git` watcher and the shared ref selection.
 * The sidebar tree and the editor timeline are thin views that attach to it, so neither depends on the
 * other being open and both always render the same snapshot, selection and busy status.
 */
export class RepoCoordinator implements vscode.Disposable {
  private readonly surfaces = new Map<SurfaceId, WebviewSurface>();
  private readonly readySurfaces = new Set<SurfaceId>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositoryChangeListeners = new Set<(repoRoot: string | null) => void>();
  private readonly gitService: GitService;
  private readonly githubService: GitHubService;
  private readonly cloneDiscoveryService: CloneDiscoveryService;
  private loadSequence = 0;
  private disposed = false;
  private lastSnapshot: RepoSnapshot | null = null;
  private selection: SyncStatePayload = EMPTY_SELECTION;
  private status: ActionStatusPayload = { busy: false };
  private integrations: ExternalIntegrationsInfo = {
    gitGraphAvailable: false,
    gitGraphExtensionId: null,
    githubRemoteUrl: null,
    remoteWebUrl: null,
    remoteProvider: null,
    remoteProviderName: null,
  };
  private operationInProgress = false;
  private discoveredRepos: WorkspaceRepoInfo[] = [];
  private selectedRepoRoot: string | null = null;
  private readonly githubRemoteByRepo = new Map<string, string | undefined>();
  private gitWatcher: vscode.FileSystemWatcher | undefined;
  private gitWatcherSubscriptions: vscode.Disposable[] = [];
  private watchedRepoRoot: string | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRevealCommitHash: string | null = null;
  private pendingCreateBranchDialog: CreateBranchDialogRequest | null = null;
  private pendingCreateWorktreeDialog: CreateWorktreeDialogPayload | null = null;
  private activeFileHistory: FileHistoryResult | null = null;
  private pendingFileHistory: FileHistoryResult | null = null;
  private isLoadingMoreCommits = false;
  private loadingMoreCommits: Promise<boolean> | null = null;
  private isSearchingForRevealCommit = false;

  constructor(
    private readonly host: RepoCoordinatorHost,
    private readonly gitDiffProvider?: GitShowContentProvider,
    dependencies: RepoCoordinatorDependencies = {},
  ) {
    this.gitService = dependencies.gitService ?? new GitService();
    this.githubService = dependencies.githubService ?? new GitHubService();
    this.cloneDiscoveryService = dependencies.cloneDiscoveryService ?? new CloneDiscoveryService();
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshIfAttached(), null, this.disposables);
    vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshIfAttached(), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (
          event.affectsConfiguration('gitRepoAndBranchExplorer.workspaceRoot') &&
          this.surfaces.size > 0
        ) {
          this.refreshIfAttached();
        }
      },
      null,
      this.disposables,
    );
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
    this.readySurfaces.delete(surface.id);
    this.surfaces.set(surface.id, surface);
  }

  public detach(surface: WebviewSurface): void {
    if (this.surfaces.get(surface.id) !== surface) {
      return;
    }
    this.surfaces.delete(surface.id);
    this.readySurfaces.delete(surface.id);
    if (this.surfaces.size === 0) {
      this.release();
    }
  }

  public refresh(): void {
    void this.loadRepository();
  }

  public onDidRepositoryChange(listener: (repoRoot: string | null) => void): vscode.Disposable {
    this.repositoryChangeListeners.add(listener);
    return new vscode.Disposable(() => this.repositoryChangeListeners.delete(listener));
  }

  public getActiveRepoRoot(): string | null {
    return this.lastSnapshot?.repoRoot ?? null;
  }

  public getGithubRemoteUrl(): string | undefined {
    return this.integrations.githubRemoteUrl ?? undefined;
  }

  public getRepoRootForFile(filePath: string): string | null {
    const candidate = canonicalizeRepoPath(filePath);
    const repoRoots = this.discoveredRepos
      .map((repo) => ({ original: repo.repoRoot, canonical: canonicalizeRepoPath(repo.repoRoot) }))
      .sort((left, right) => right.canonical.length - left.canonical.length);
    for (const repo of repoRoots) {
      if (this.isPathInsideRepo(repo.canonical, candidate)) {
        return repo.original;
      }
    }
    const activeRepoRoot = this.getActiveRepoRoot();
    return activeRepoRoot && this.isPathInsideRepo(canonicalizeRepoPath(activeRepoRoot), candidate)
      ? activeRepoRoot
      : null;
  }

  private isPathInsideRepo(repoRoot: string, candidatePath: string): boolean {
    const relative = path.relative(repoRoot, candidatePath);
    return relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  public async getGithubRemoteUrlForRepo(repoRoot: string): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) {
      return undefined;
    }
    const matchedRoot = this.discoveredRepos.find(
      (repo) => canonicalizeRepoPath(repo.repoRoot) === canonicalizeRepoPath(repoRoot),
    )?.repoRoot;
    if (!matchedRoot) {
      return undefined;
    }
    const key = normalizeRepoRootPath(matchedRoot);
    if (this.githubRemoteByRepo.has(key)) {
      return this.githubRemoteByRepo.get(key);
    }
    let githubRemoteUrl: string | undefined;
    try {
      githubRemoteUrl = await this.gitService.getGitHubRemoteUrl(matchedRoot) ?? undefined;
    } catch {
      githubRemoteUrl = undefined;
    }
    this.githubRemoteByRepo.set(key, githubRemoteUrl);
    return githubRemoteUrl;
  }

  public revealCommit(hash: string): void {
    if (!isValidCommitHash(hash)) {
      return;
    }
    this.pendingRevealCommitHash = hash.toLowerCase();
    this.flushPendingRevealCommit();
  }

  /** Handles an untrusted message from `source`; anything that is not a valid webview message is dropped. */
  public handleMessage(source: SurfaceId, message: unknown): void {
    if (!isWebviewToExtensionMessage(message)) {
      return;
    }
    switch (message.type) {
      case 'webviewReady':
        this.readySurfaces.add(source);
        this.sendInitialState(source);
        if (source === 'editor') {
          if (this.activeFileHistory !== null && this.pendingFileHistory === null) {
            this.pendingFileHistory = this.activeFileHistory;
          }
          this.flushPendingRevealCommit();
          this.flushPendingCreateBranchDialog();
          this.flushPendingCreateWorktreeDialog();
          this.flushPendingFileHistory();
        }
        break;
      case 'requestRefresh':
        void this.loadRepository();
        break;
      case 'cloneRepository':
        void this.cloneRepository();
        break;
      case 'selectRepository':
        this.handleSelectRepository(message.payload.repoRoot);
        break;
      case 'loadMoreCommits':
        void this.loadNextCommitPage().catch((err: unknown) => {
          const snapshot = this.lastSnapshot;
          void vscode.window.showWarningMessage(`Could not load older commits: ${describeError(err)}`);
          if (snapshot) {
            this.broadcast({
              type: 'commitsAppended',
              payload: { commits: [], hasMoreCommits: snapshot.hasMoreCommits },
            });
          }
        });
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
      case 'searchCommitsByFile':
        void this.handleSearchCommitsByFile(message.payload.query, message.payload.requestId);
        break;
      case 'createBranchAtRef':
        void this.openCreateBranchDialog(message.payload.startPoint);
        break;
      case 'openCreateBranchDialog':
        void this.openCreateBranchDialog(message.payload.startPoint, message.payload.sourceKind);
        break;
      case 'submitCreateBranch':
        void this.handleSubmitCreateBranch(message.payload);
        break;
      case 'browseWorktreeParentFolder':
        void this.handleBrowseWorktreeParentFolder(message.payload.currentParentPath);
        break;
      case 'submitCreateWorktree':
        void this.handleSubmitCreateWorktree(message.payload);
        break;
      case 'stashChanges':
        void this.handleStashChanges();
        break;
      case 'inspectStash':
        void this.handleInspectStash(message.ref, message.hash);
        break;
      case 'applyStash':
        void this.handleApplyStash(message.ref);
        break;
      case 'popStash':
        void this.handlePopStash(message.ref);
        break;
      case 'dropStash':
        void this.handleDropStash(message.ref);
        break;
      case 'setTabPinned':
        this.host.setTabPinned(message.payload.pinned);
        break;
      case 'setShowCheckedOutBadge':
        this.host.setShowCheckedOutBadge(message.payload.show);
        break;
      case 'setShowFolderCounts':
        this.host.setShowFolderCounts(message.payload.show);
        this.publishInitState();
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
      case 'openFile':
        void this.openFile(message.payload);
        break;
      case 'openInGitGraph':
        if (this.lastSnapshot) {
          void openInGitGraph(this.lastSnapshot.repoRoot);
        }
        break;
      case 'openCommitOnGitHub':
        void this.openCommitOnGitHub(message.payload.hash);
        break;
      case 'closeFileHistory':
        this.activeFileHistory = null;
        this.pendingFileHistory = null;
        this.broadcast({ type: 'clearFileHistory' });
        break;
      case 'loadMoreFileHistory':
        void this.loadMoreFileHistory();
        break;
      case 'compareFileRevisions':
        void this.compareFileRevisions(message.payload);
        break;
      case 'compareRevisionWithWorkingTree':
        void this.compareRevisionWithWorkingTree(message.payload);
        break;
      case 'openFileAtRevision':
        void this.openFileAtRevision(message.payload);
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
      this.host.getShowFolderCounts(),
      this.host.getTrackingOrder(),
    );
  }

  public async cloneRepository(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(WORKSPACE_TRUST_ERROR_MESSAGE);
      return;
    }
    if (this.operationInProgress) {
      void vscode.window.showInformationMessage('Another Git operation is already running.');
      return;
    }

    const source = await vscode.window.showQuickPick(
      [
        { label: 'Clone from URL…', value: 'url' as const },
        { label: 'Browse GitHub (github.com)', value: 'github' as const },
        { label: 'Browse GitHub Enterprise (*.ghe.com / Server)', value: 'githubEnterprise' as const },
        { label: 'Browse Azure DevOps', value: 'azureDevOps' as const },
      ],
      { title: 'Clone Repository', ignoreFocusOut: true },
    );
    if (!source) {
      return;
    }

    const resolved = await this.resolveCloneSource(source.value);
    if (!resolved) {
      return;
    }
    const parentDir = await this.chooseCloneParentFolder();
    if (!parentDir) {
      return;
    }
    const folderName = await vscode.window.showInputBox({
      title: 'Clone Repository',
      prompt: 'Folder name',
      value: resolved.defaultFolderName,
      ignoreFocusOut: true,
      validateInput: (name) => {
        const validation = validateCloneFolderName(name);
        if (!validation.valid) {
          return validation.error;
        }
        return fs.existsSync(path.join(parentDir, name)) ? 'A file or folder with that name already exists.' : undefined;
      },
    });
    if (folderName === undefined) {
      return;
    }

    this.operationInProgress = true;
    this.postActionStatus(true, `Cloning ${folderName}…`);
    let clonedPath: string;
    try {
      clonedPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${folderName}…`,
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            return await this.gitService.cloneRepository(
              resolved.cloneUrl,
              parentDir,
              folderName,
              { signal: controller.signal },
            );
          } finally {
            cancellation.dispose();
          }
        },
      );
    } catch (err) {
      if (err instanceof GitExecutionError && err.code === 'CANCELLED') {
        void vscode.window.showInformationMessage('Clone cancelled.');
        return;
      }
      void vscode.window.showErrorMessage(`Could not clone repository: ${describeError(err)}`);
      return;
    } finally {
      this.operationInProgress = false;
      this.postActionStatus(false);
    }
    await this.offerPostCloneActions(clonedPath);
  }

    public async viewFileHistoryByUri(uri?: vscode.Uri): Promise<void> {
      if (!this.ensureTrustedWorkspace()) {
        return;
      }
      const target = await this.resolveHistoryFileTarget(uri);
      if (target === null) {
        return;
      }
      try {
        const page = await this.gitService.getFileHistory(target.repoRoot, target.relativePath);
        await this.prepareFileHistoryRepo(target.repoRoot);
        const result: FileHistoryResult = {
          kind: 'file',
          repoRoot: target.repoRoot,
          filePath: target.relativePath,
          commits: page.commits,
          hasMore: page.hasMore,
        };
        this.showFileHistory(result);
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not load file history: ${describeError(err)}`);
      }
    }

    public async viewLineHistoryForActiveEditor(): Promise<void> {
      if (!this.ensureTrustedWorkspace()) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showInformationMessage('Select lines in a file on disk to view line history.');
        return;
      }
      const target = await this.resolveHistoryFileTarget(editor.document.uri);
      if (target === null) {
        return;
      }
      const startLine = editor.selection.start.line + 1;
      let endLine = editor.selection.end.line + 1;
      if (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line) {
        endLine--;
      }
      try {
        const page = await this.gitService.getLineHistory(
          target.repoRoot,
          target.relativePath,
          startLine,
          endLine,
        );
        await this.prepareFileHistoryRepo(target.repoRoot);
        this.showFileHistory({
          kind: 'line',
          repoRoot: target.repoRoot,
          filePath: target.relativePath,
          startLine,
          endLine,
          commits: page.commits,
          hasMore: page.hasMore,
        });
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not load line history: ${describeError(err)}`);
      }
    }

    public async compareWithPreviousRevisionByUri(uri?: vscode.Uri): Promise<void> {
      if (!this.ensureTrustedWorkspace() || !this.gitDiffProvider) {
        return;
      }
      const target = await this.resolveHistoryFileTarget(uri);
      if (target === null) {
        return;
      }
      try {
        const [page, changes] = await Promise.all([
          this.gitService.getFileHistory(target.repoRoot, target.relativePath, 2),
          this.gitService.getWorkingTreeFiles(target.repoRoot),
        ]);
        this.allowDiffForRepo(target.repoRoot);
        const dirty = changes.some(
          (file) =>
            this.sameRepoPath(file.path, target.relativePath) ||
            (file.originalPath !== undefined && this.sameRepoPath(file.originalPath, target.relativePath)),
        );
        if (dirty && page.commits[0]) {
          await this.gitDiffProvider.openRevisionVsWorkingTreeDiff(
            target.repoRoot,
            this.revisionAtCommit(page.commits[0]),
            target.relativePath,
          );
        } else if (page.commits.length >= 2) {
          await this.gitDiffProvider.openTwoRevisionFileDiff(
            target.repoRoot,
            this.versionedRevision(page.commits[1]),
            this.versionedRevision(page.commits[0]),
          );
        } else {
          void vscode.window.showInformationMessage('No previous revision found for this file.');
        }
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not compare previous revisions: ${describeError(err)}`);
      }
    }

    public async openPreviousRevisionByUri(uri?: vscode.Uri): Promise<void> {
      if (!this.ensureTrustedWorkspace() || !this.gitDiffProvider) {
        return;
      }
      const target = await this.resolveHistoryFileTarget(uri);
      if (target === null) {
        return;
      }
      try {
        const [page, changes] = await Promise.all([
          this.gitService.getFileHistory(target.repoRoot, target.relativePath, 2),
          this.gitService.getWorkingTreeFiles(target.repoRoot),
        ]);
        const dirty = changes.some(
          (file) =>
            this.sameRepoPath(file.path, target.relativePath) ||
            (file.originalPath !== undefined && this.sameRepoPath(file.originalPath, target.relativePath)),
        );
        const revision = dirty ? page.commits[0] : page.commits[1];
        if (!revision) {
          void vscode.window.showInformationMessage('No previous revision found for this file.');
          return;
        }
        this.allowDiffForRepo(target.repoRoot);
        await this.gitDiffProvider.openSingleRevisionFile(
          target.repoRoot,
          this.revisionAtCommit(revision),
        );
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not open the previous revision: ${describeError(err)}`);
      }
    }

    private async resolveHistoryFileTarget(
      uri?: vscode.Uri,
    ): Promise<{ repoRoot: string; relativePath: string } | null> {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri || targetUri.scheme !== 'file') {
        void vscode.window.showInformationMessage('Select a file on disk.');
        return null;
      }
      if (this.discoveredRepos.length === 0) {
        const workspaceFolderPaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
        const configuredWorkspaceRoot = vscode.workspace
          .getConfiguration('gitRepoAndBranchExplorer')
          .get<string>('workspaceRoot', '')
          .trim();
        try {
          this.discoveredRepos = await discoverWorkspaceRepositories(
            workspaceFolderPaths,
            configuredWorkspaceRoot,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Could not discover Git repositories: ${describeError(err)}`,
          );
          return null;
        }
      }
      const candidateRoots = [
        ...this.discoveredRepos.map((repo) => repo.repoRoot),
        ...(this.lastSnapshot?.worktrees?.map((worktree) => worktree.path) ?? []),
        ...(this.lastSnapshot?.repoRoot === undefined ? [] : [this.lastSnapshot.repoRoot]),
      ];
      const candidatePath = canonicalizeRepoPath(targetUri.fsPath);
      const targetRepoRoot = Array.from(
        new Map(candidateRoots.map((root) => [normalizeRepoRootPath(root), root])).entries(),
      )
        .filter(([root]) => this.isPathInsideRepo(root, candidatePath))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1];
      if (targetRepoRoot === undefined) {
        void vscode.window.showInformationMessage('This file is not inside a Git repository.');
        return null;
      }
      const relativePath = path.relative(targetRepoRoot, targetUri.fsPath).replace(/\\/g, '/');
      if (!isSafeRepoRelativePath(relativePath)) {
        void vscode.window.showInformationMessage('Select a file inside a Git repository.');
        return null;
      }
      return { repoRoot: targetRepoRoot, relativePath };
    }

    private async prepareFileHistoryRepo(repoRoot: string): Promise<void> {
      if (
        this.lastSnapshot === null ||
        canonicalizeRepoPath(this.lastSnapshot.repoRoot) !== canonicalizeRepoPath(repoRoot)
      ) {
        this.selectedRepoRoot = repoRoot;
        await this.loadRepository();
      }
      this.allowDiffForRepo(repoRoot);
    }

    private showFileHistory(result: FileHistoryResult): void {
      this.activeFileHistory = result;
      this.pendingFileHistory = result;
      this.host.openPanel();
      this.flushPendingFileHistory();
    }

    private flushPendingFileHistory(): void {
      const result = this.pendingFileHistory;
      const editor = this.surfaces.get('editor');
      if (result === null || !editor || !this.readySurfaces.has('editor')) {
        return;
      }
      editor.post({ type: 'fileHistoryLoaded', payload: result });
      if (this.pendingFileHistory === result) {
        this.pendingFileHistory = null;
      }
    }

    private sameRepoPath(left: string, right: string): boolean {
      const normalized = (value: string): string =>
        process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value.replace(/\\/g, '/');
      return normalized(left) === normalized(right);
    }

    private allowDiffForRepo(repoRoot: string): void {
      this.gitDiffProvider?.setAllowedRepoRoots(new Set([
        ...this.discoveredRepos.map((repo) => repo.repoRoot),
        ...(this.lastSnapshot?.worktrees?.map((worktree) => worktree.path) ?? []),
        ...(this.lastSnapshot?.repoRoot === undefined ? [] : [this.lastSnapshot.repoRoot]),
        repoRoot,
      ]));
    }

    private versionedRevision(commit: FileHistoryResult['commits'][number]): {
      hash: string;
      shortHash: string;
      path: string;
      isoDate?: string;
    } {
      return {
        hash: commit.hash,
        shortHash: commit.shortHash,
        path: commit.filePathAtCommit,
        isoDate: commit.authorDateIso,
      };
    }

    private revisionAtCommit(commit: FileHistoryResult['commits'][number]): {
      hash: string;
      shortHash: string;
      pathAtCommit: string;
      isoDate?: string;
    } {
      return {
        hash: commit.hash,
        shortHash: commit.shortHash,
        pathAtCommit: commit.filePathAtCommit,
        isoDate: commit.authorDateIso,
      };
    }

    private async loadMoreFileHistory(): Promise<void> {
      const history = this.activeFileHistory;
      if (history === null || history.kind !== 'file' || !history.hasMore) {
        return;
      }
      if (!this.ensureTrustedWorkspace()) {
        return;
      }
      try {
        const page = await this.gitService.getFileHistory(
          history.repoRoot,
          history.filePath,
          200,
          history.commits.length,
        );
        if (this.activeFileHistory !== history) {
          return;
        }
        const knownHashes = new Set(history.commits.map((commit) => commit.hash));
        const appended = page.commits.filter((commit) => {
          if (knownHashes.has(commit.hash)) {
            return false;
          }
          knownHashes.add(commit.hash);
          return true;
        });
        history.commits = [...history.commits, ...appended];
        history.hasMore = page.hasMore;
        this.broadcast({
          type: 'fileHistoryAppended',
          payload: { filePath: history.filePath, commits: appended, hasMore: history.hasMore },
        });
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not load older file history: ${describeError(err)}`);
        this.broadcast({
          type: 'fileHistoryAppended',
          payload: { filePath: history.filePath, commits: [], hasMore: history.hasMore },
        });
      }
    }

    private async compareFileRevisions(payload: {
      olderHash: string;
      olderPath: string;
      newerHash: string;
      newerPath: string;
    }): Promise<void> {
      const history = this.activeFileHistory;
      if (history === null || !this.ensureTrustedWorkspace() || !this.gitDiffProvider) {
        return;
      }
      const older = history.commits.findIndex(
        (commit) =>
          commit.hash === payload.olderHash.toLowerCase() &&
          this.sameRepoPath(commit.filePathAtCommit, payload.olderPath),
      );
      const newer = history.commits.findIndex(
        (commit) =>
          commit.hash === payload.newerHash.toLowerCase() &&
          this.sameRepoPath(commit.filePathAtCommit, payload.newerPath),
      );
      if (older < 0 || newer < 0 || older === newer) {
        void vscode.window.showWarningMessage('The selected revisions are no longer available.');
        return;
      }
      const first = history.commits[older];
      const second = history.commits[newer];
      const firstIsOlder =
        first.authorTimestamp < second.authorTimestamp ||
        (first.authorTimestamp === second.authorTimestamp && older > newer);
      const orderedOlder = firstIsOlder ? first : second;
      const orderedNewer = firstIsOlder ? second : first;
      this.allowDiffForRepo(history.repoRoot);
      try {
        await this.gitDiffProvider.openTwoRevisionFileDiff(
          history.repoRoot,
          this.versionedRevision(orderedOlder),
          this.versionedRevision(orderedNewer),
        );
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not compare the selected revisions: ${describeError(err)}`);
      }
    }

    private async compareRevisionWithWorkingTree(payload: {
      hash: string;
      filePathAtCommit: string;
      currentFilePath: string;
    }): Promise<void> {
      const history = this.activeFileHistory;
      if (history === null || !this.ensureTrustedWorkspace() || !this.gitDiffProvider) {
        return;
      }
      const revision = history.commits.find(
        (commit) =>
          commit.hash === payload.hash.toLowerCase() &&
          this.sameRepoPath(commit.filePathAtCommit, payload.filePathAtCommit),
      );
      if (!revision || !this.sameRepoPath(history.filePath, payload.currentFilePath)) {
        return;
      }
      this.allowDiffForRepo(history.repoRoot);
      try {
        await this.gitDiffProvider.openRevisionVsWorkingTreeDiff(
          history.repoRoot,
          this.revisionAtCommit(revision),
          payload.currentFilePath,
        );
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not compare with the working tree: ${describeError(err)}`);
      }
    }

    private async openFileAtRevision(payload: {
      hash: string;
      filePathAtCommit: string;
    }): Promise<void> {
      const history = this.activeFileHistory;
      if (history === null || !this.ensureTrustedWorkspace() || !this.gitDiffProvider) {
        return;
      }
      const revision = history.commits.find(
        (commit) =>
          commit.hash === payload.hash.toLowerCase() &&
          this.sameRepoPath(commit.filePathAtCommit, payload.filePathAtCommit),
      );
      if (!revision) {
        return;
      }
      this.allowDiffForRepo(history.repoRoot);
      try {
        await this.gitDiffProvider.openSingleRevisionFile(
          history.repoRoot,
          this.revisionAtCommit(revision),
        );
      } catch (err) {
        void vscode.window.showWarningMessage(`Could not open the file revision: ${describeError(err)}`);
      }
    }

  public async stashFileByUri(uri?: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(WORKSPACE_TRUST_ERROR_MESSAGE);
      return;
    }
    if (this.operationInProgress) {
      void vscode.window.showInformationMessage('Another Git operation is already running.');
      return;
    }

    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || targetUri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Select a file on disk to stash.');
      return;
    }

    try {
      if (fs.statSync(targetUri.fsPath).isDirectory()) {
        void vscode.window.showInformationMessage('Select a file (not a folder) to stash.');
        return;
      }
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Could not inspect the selected file: ${describeError(err)}`,
      );
      return;
    }

    if (this.discoveredRepos.length === 0) {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage(WORKSPACE_TRUST_ERROR_MESSAGE);
        return;
      }
      const workspaceFolderPaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
      const configuredWorkspaceRoot = vscode.workspace
        .getConfiguration('gitRepoAndBranchExplorer')
        .get<string>('workspaceRoot', '')
        .trim();
      try {
        this.discoveredRepos = await discoverWorkspaceRepositories(
          workspaceFolderPaths,
          configuredWorkspaceRoot,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not discover Git repositories: ${describeError(err)}`,
        );
        return;
      }
    }

    const candidateRoots = [
      ...this.discoveredRepos.map((repo) => repo.repoRoot),
      ...(this.lastSnapshot?.worktrees?.map((worktree) => worktree.path) ?? []),
      ...(this.lastSnapshot?.repoRoot === undefined ? [] : [this.lastSnapshot.repoRoot]),
    ];
    const candidatePath = canonicalizeRepoPath(targetUri.fsPath);
    const targetRepoRoot = Array.from(
      new Map(
        candidateRoots.map((repoRoot) => [normalizeRepoRootPath(repoRoot), repoRoot]),
      ).entries(),
    )
      .filter(([normalizedRoot]) => this.isPathInsideRepo(normalizedRoot, candidatePath))
      .sort(([left], [right]) => right.length - left.length)[0]?.[1];
    if (targetRepoRoot === undefined) {
      void vscode.window.showInformationMessage('This file is not inside a Git repository.');
      return;
    }

    const relativePath = path.relative(targetRepoRoot, targetUri.fsPath).replace(/\\/g, '/');
    if (
      relativePath.length === 0 ||
      path.posix.isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith('../')
    ) {
      void vscode.window.showInformationMessage('Select a file inside a Git repository to stash.');
      return;
    }

    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(WORKSPACE_TRUST_ERROR_MESSAGE);
      return;
    }
    if (this.operationInProgress) {
      void vscode.window.showInformationMessage('Another Git operation is already running.');
      return;
    }
    let entry: WorkingTreeFile | undefined;
    try {
      const files = await this.gitService.getWorkingTreeFiles(targetRepoRoot);
      const matchesPath = (candidate: string): boolean =>
        process.platform === 'win32'
          ? candidate.toLowerCase() === relativePath.toLowerCase()
          : candidate === relativePath;
      entry = files.find(
        (file) => matchesPath(file.path) || (file.originalPath !== undefined && matchesPath(file.originalPath)),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not read changes for ${path.basename(targetUri.fsPath)}: ${describeError(err)}`,
      );
      return;
    }
    if (entry === undefined) {
      void vscode.window.showInformationMessage(
        'No uncommitted changes to stash for ' + path.basename(targetUri.fsPath) + '.',
      );
      return;
    }

    const message = await vscode.window.showInputBox({
      title: 'Stash File',
      prompt: 'Optional stash message for ' + entry.path,
      placeHolder: 'Leave blank for default stash message',
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(WORKSPACE_TRUST_ERROR_MESSAGE);
      return;
    }
    if (this.operationInProgress) {
      void vscode.window.showInformationMessage('Another Git operation is already running.');
      return;
    }

    this.operationInProgress = true;
    this.postActionStatus(true, `Stashing ${path.basename(entry.path)}…`);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Stashing ${path.basename(entry.path)}…`,
          cancellable: false,
        },
        () => this.gitService.stashPush(targetRepoRoot, {
          includeUntracked: entry.untracked,
          ...(message.trim() === '' ? {} : { message }),
          paths: entry.originalPath === undefined
            ? [entry.path]
            : [entry.originalPath, entry.path],
        }),
      );
      void vscode.window.showInformationMessage('Stashed ' + entry.path + '.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not stash ${entry.path}: ${describeError(err)}`);
    } finally {
      this.operationInProgress = false;
      this.postActionStatus(false);
      const snapshotRoots = this.lastSnapshot === null
        ? []
        : [
            this.lastSnapshot.repoRoot,
            ...this.lastSnapshot.worktrees?.map((worktree) => worktree.path) ?? [],
          ];
      if (
        snapshotRoots.some(
          (repoRoot) => normalizeRepoRootPath(repoRoot) === normalizeRepoRootPath(targetRepoRoot),
        )
      ) {
        await this.loadRepository();
      } else {
        this.notifyRepositoryChange(targetRepoRoot);
      }
    }
  }

  private async resolveCloneSource(
    source: 'url' | 'github' | 'githubEnterprise' | 'azureDevOps',
  ): Promise<{ cloneUrl: string; defaultFolderName: string; displayLabel: string } | null> {
    if (source === 'url') {
      const cloneUrl = await vscode.window.showInputBox({
        title: 'Clone Repository',
        prompt: 'Paste a repository URL or local path',
        ignoreFocusOut: true,
        validateInput: (value) => validateCloneUrl(value).error,
      });
      if (cloneUrl === undefined) {
        return null;
      }
      const validated = validateCloneUrl(cloneUrl);
      if (!validated.valid || validated.normalized === undefined) {
        void vscode.window.showWarningMessage(validated.error ?? 'Repository URL is invalid.');
        return null;
      }
      return {
        cloneUrl: validated.normalized,
        defaultFolderName: extractCloneFolderName(validated.normalized),
        displayLabel: validated.normalized,
      };
    }

    if (source === 'github') {
      const session = await this.getAuthenticationSession('github', ['repo', 'read:org']);
      if (!session) {
        return null;
      }
      const repos = await this.loadCloneRepositories(
        'Loading GitHub repositories…',
        () => this.cloneDiscoveryService.listGitHubRepos(session.accessToken),
      );
      return repos === null ? null : this.pickCloneRepository(repos, 'Choose GitHub Repository');
    }

    if (source === 'githubEnterprise') {
      const configured = vscode.workspace
        .getConfiguration('github-enterprise')
        .get<string>('uri', '')
        .trim();
      let enterpriseUri = resolveGitHubEnterpriseApiBaseUrl(configured) ? configured : '';
      if (!enterpriseUri) {
        const entered = await vscode.window.showInputBox({
          title: 'GitHub Enterprise',
          prompt: 'GitHub Enterprise server URL',
          placeHolder: 'https://your-company.ghe.com',
          value: configured,
          ignoreFocusOut: true,
          validateInput: (value) =>
            resolveGitHubEnterpriseApiBaseUrl(value)
              ? undefined
              : 'Enter a valid GitHub Enterprise HTTPS URL.',
        });
        if (entered === undefined) {
          return null;
        }
        enterpriseUri = entered.trim();
      }
      const session = await this.getAuthenticationSession('github-enterprise', ['repo', 'read:org']);
      if (!session) {
        return null;
      }
      const repos = await this.loadCloneRepositories(
        'Loading GitHub Enterprise repositories…',
        () => this.cloneDiscoveryService.listGitHubEnterpriseRepos(enterpriseUri, session.accessToken),
      );
      return repos === null ? null : this.pickCloneRepository(repos, 'Choose GitHub Enterprise Repository');
    }

    const session = await this.getAuthenticationSession(
      'microsoft',
      ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
    );
    if (!session) {
      return null;
    }
    let organizations: Awaited<ReturnType<CloneDiscoveryService['listAzureDevOpsOrganizations']>> = [];
    try {
      organizations = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading Azure DevOps organizations…' },
        () => this.cloneDiscoveryService.listAzureDevOpsOrganizations(session.accessToken),
      );
    } catch (err) {
      void vscode.window.showInformationMessage(
        `Azure DevOps organization discovery was unavailable: ${describeError(err)} Enter an organization name to continue.`,
      );
    }
    const orgName = await this.pickAzureDevOpsOrganization(organizations);
    if (!orgName) {
      return null;
    }
    const repos = await this.loadCloneRepositories(
      `Loading repositories from ${orgName}…`,
      () => this.cloneDiscoveryService.listAzureDevOpsRepos(orgName, session.accessToken),
    );
    if (repos === null) {
      return null;
    }
    const selected = await vscode.window.showQuickPick(
      repos.map((repo) => ({ label: repo.fullName, detail: repo.cloneUrl, repo })),
      { title: 'Choose Azure DevOps Repository', matchOnDetail: true, ignoreFocusOut: true },
    );
    if (!selected) {
      return null;
    }
    return {
      cloneUrl: selected.repo.cloneUrl,
      defaultFolderName: extractCloneFolderName(selected.repo.cloneUrl),
      displayLabel: selected.label,
    };
  }

  private async getAuthenticationSession(
    providerId: string,
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(providerId, scopes, { createIfNone: true });
    } catch (err) {
      void vscode.window.showWarningMessage(`Authentication was not completed: ${describeError(err)}`);
      return undefined;
    }
  }

  private async loadCloneRepositories(
    title: string,
    load: () => Promise<Awaited<ReturnType<CloneDiscoveryService['listGitHubRepos']>>>,
  ): Promise<Awaited<ReturnType<CloneDiscoveryService['listGitHubRepos']>> | null> {
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, load);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not load repositories: ${describeError(err)}`);
      return null;
    }
  }

  private async pickCloneRepository(
    repos: Awaited<ReturnType<CloneDiscoveryService['listGitHubRepos']>>,
    title: string,
  ): Promise<{ cloneUrl: string; defaultFolderName: string; displayLabel: string } | null> {
    const selected = await vscode.window.showQuickPick(
      repos.map((repo) => ({
        label: repo.fullName,
        description: repo.isPrivate ? 'Private' : 'Public',
        detail: repo.description,
        repo,
      })),
      { title, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
    );
    if (!selected) {
      return null;
    }
    return {
      cloneUrl: selected.repo.cloneUrl,
      defaultFolderName: extractCloneFolderName(selected.repo.cloneUrl),
      displayLabel: selected.label,
    };
  }

  private async pickAzureDevOpsOrganization(
    organizations: readonly { accountName: string; accountUri: string }[],
  ): Promise<string | null> {
    if (organizations.length > 0) {
      const selected = await vscode.window.showQuickPick(
        [
          ...organizations.map((org) => ({
            label: org.accountName,
            detail: org.accountUri,
            orgName: org.accountName,
          })),
          { label: 'Enter Azure DevOps organization name…', orgName: '' },
        ],
        { title: 'Choose Azure DevOps Organization', ignoreFocusOut: true },
      );
      if (!selected) {
        return null;
      }
      if (selected.orgName.length > 0) {
        return selected.orgName;
      }
    }
    return this.promptAzureDevOpsOrganizationName();
  }

  private async promptAzureDevOpsOrganizationName(): Promise<string | null> {
    const orgName = await vscode.window.showInputBox({
      title: 'Azure DevOps Organization',
      prompt: 'Organization name',
      placeHolder: 'your-organization',
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
          ? undefined
          : 'Enter a valid Azure DevOps organization name.',
    });
    return orgName ?? null;
  }

  private async chooseCloneParentFolder(): Promise<string | null> {
    const workspaceRoot = vscode.workspace
      .getConfiguration('gitRepoAndBranchExplorer')
      .get<string>('workspaceRoot', '')
      .trim();
    let workspaceRootIsDirectory = false;
    if (workspaceRoot.length > 0 && fs.existsSync(workspaceRoot)) {
      workspaceRootIsDirectory = fs.statSync(workspaceRoot).isDirectory();
    }
    if (workspaceRootIsDirectory) {
      const destination = await vscode.window.showQuickPick(
        [
          { label: 'Clone into Workspace Root', detail: workspaceRoot, useWorkspaceRoot: true },
          { label: 'Choose another folder…', useWorkspaceRoot: false },
        ],
        { title: 'Clone Destination', ignoreFocusOut: true },
      );
      if (!destination) {
        return null;
      }
      if (destination.useWorkspaceRoot) {
        return workspaceRoot;
      }
    }
    const [folder] = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Destination Folder',
    }) ?? [];
    return folder?.fsPath ?? null;
  }

  private async offerPostCloneActions(clonedPath: string): Promise<void> {
    const configuredRoot = vscode.workspace
      .getConfiguration('gitRepoAndBranchExplorer')
      .get<string>('workspaceRoot', '')
      .trim();
    const workspaceRoots = [
      ...(configuredRoot.length > 0 ? [configuredRoot] : []),
      ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []),
    ];
    const clonedInsideWorkspace = workspaceRoots.some((root) => this.isPathInsideRepo(
      canonicalizeRepoPath(root),
      canonicalizeRepoPath(clonedPath),
    ));
    const action = await vscode.window.showQuickPick(
      [
        ...(clonedInsideWorkspace
          ? [{
              label: 'Open in Git Repo & Branch Explorer (Stay in Window)',
              detail: clonedPath,
              action: 'stay' as const,
            }]
          : []),
        { label: 'Add to Workspace', detail: clonedPath, action: 'add' as const },
        { label: 'Open in New Window', detail: clonedPath, action: 'newWindow' as const },
        { label: 'Open in Current Window', detail: clonedPath, action: 'currentWindow' as const },
      ],
      { title: 'Repository Cloned', ignoreFocusOut: true },
    );
    if (!action) {
      return;
    }
    switch (action.action) {
      case 'stay':
        this.selectedRepoRoot = clonedPath;
        await this.loadRepository();
        void vscode.window.showInformationMessage(`Opened ${path.basename(clonedPath)} in Git Repo & Branch Explorer.`);
        break;
      case 'add': {
        const added = vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          { uri: vscode.Uri.file(clonedPath) },
        );
        if (!added) {
          void vscode.window.showWarningMessage('VS Code could not add the cloned repository to the workspace.');
          return;
        }
        this.selectedRepoRoot = clonedPath;
        await this.loadRepository();
        break;
      }
      case 'newWindow':
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(clonedPath), { forceNewWindow: true });
        break;
      case 'currentWindow':
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(clonedPath), { forceNewWindow: false });
        break;
    }
  }

  /**
   * Pushes changed preferences to every attached view. A webview treats `initState` as the start of a load,
   * so the cached snapshot is re-sent right after to end that loading state.
   */
  public publishInitState(): void {
    this.broadcast({ type: 'initState', payload: this.getInitState() });
    this.broadcast({
      type: 'workspaceRepos',
      payload: { repos: this.discoveredRepos, activeRepoRoot: this.lastSnapshot?.repoRoot ?? null },
    });
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
    surface.post({
      type: 'workspaceRepos',
      payload: { repos: this.discoveredRepos, activeRepoRoot: snapshot.repoRoot },
    });
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
    this.discoveredRepos = [];
    this.selectedRepoRoot = null;
    this.githubRemoteByRepo.clear();
    this.selection = EMPTY_SELECTION;
    this.pendingCreateBranchDialog = null;
    this.pendingCreateWorktreeDialog = null;
    this.activeFileHistory = null;
    this.pendingFileHistory = null;
    this.gitDiffProvider?.clearAllowedRepoRoots();
    this.disposeGitWatcher();
    this.broadcast({ type: 'workspaceRepos', payload: { repos: [], activeRepoRoot: null } });
    this.notifyRepositoryChange(null);
  }

  private handleSelectRepository(requestedRoot: string): void {
    if (this.operationInProgress || this.status.busy || !vscode.workspace.isTrusted) {
      return;
    }
    const requested = canonicalizeRepoPath(requestedRoot);
    const repository = this.discoveredRepos.find(
      (repo) => canonicalizeRepoPath(repo.repoRoot) === requested,
    );
    if (!repository) {
      void vscode.window.showWarningMessage('That repository is not in the discovered workspace repositories.');
      return;
    }
    if (
      this.lastSnapshot &&
      canonicalizeRepoPath(this.lastSnapshot.repoRoot) === canonicalizeRepoPath(repository.repoRoot)
    ) {
      return;
    }
    this.selection = EMPTY_SELECTION;
    this.broadcast({ type: 'syncState', payload: this.selection });
    this.activeFileHistory = null;
    this.pendingFileHistory = null;
    this.broadcast({ type: 'clearFileHistory' });
    this.selectedRepoRoot = repository.repoRoot;
    void this.loadRepository();
  }

  private async runGitOperation(
    title: string,
    operation: (repoRoot: string) => Promise<void>,
    failureHint?: string,
    onError?: (error: unknown) => void,
    suppressErrorNotification = false,
  ): Promise<boolean> {
    if (!this.ensureTrustedWorkspace()) {
      return false;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return false;
    }
    if (this.operationInProgress) {
      void vscode.window.showWarningMessage('Another Git operation is already running.');
      return false;
    }
    this.operationInProgress = true;
    this.postActionStatus(true, `${title}\u2026`);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => operation(snapshot.repoRoot),
      );
      return true;
    } catch (err) {
      onError?.(err);
      if (!suppressErrorNotification) {
        void vscode.window.showErrorMessage(
          `${title} failed: ${describeError(err)}${failureHint === undefined ? '' : ` ${failureHint}`}`,
        );
      }
      return false;
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
    if (branch.worktreePath) {
      void vscode.window.showWarningMessage(
        `Branch "${ref}" is already checked out in another worktree: ${branch.worktreePath}`,
      );
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
        await this.handlePush(target);
        break;
      case 'pushAndOpenPr':
        await this.handlePush(target, true);
        break;
      case 'openRepoInBrowser':
        await this.handleOpenRepoInBrowser();
        break;
      case 'openBranchInBrowser':
        await this.handleOpenBranchInBrowser(target);
        break;
      case 'openCommitInBrowser':
        await this.handleOpenCommitInBrowser(target);
        break;
      case 'createPrInBrowser':
        await this.handleCreatePrInBrowser(target);
        break;
      case 'createBranch':
        this.openCreateBranchDialog();
        break;
      case 'createTag':
        await this.handleCreateTag(target);
        break;
      case 'renameBranch':
        await this.handleRenameBranch(target);
        break;
      case 'untrackBranch':
        await this.handleUntrackBranch(target);
        break;
      case 'publishRepository':
        await this.handlePublishRepository();
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
      case 'cherryPickIntoWorktree':
        await this.handleCherryPickIntoWorktree(target);
        break;
      case 'revertMerge':
        await this.handleRevertMerge(target);
        break;
      case 'deleteBranch':
        await this.handleDeleteBranch(target);
        break;
      case 'deleteTag':
        await this.handleDeleteTag(target);
        break;
      case 'pushTag':
        await this.handlePushTag(target);
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
      case 'createWorktree':
        await this.handleCreateWorktree(target);
        break;
      case 'openWorktree':
        await this.handleOpenWorktree(target);
        break;
      case 'copyWorktreePath':
        await this.handleCopyWorktreePath(target);
        break;
      case 'removeWorktree':
        await this.handleRemoveWorktree(target);
        break;
    }
  }

  private requireSnapshotStash(ref: string) {
    if (!this.ensureTrustedWorkspace()) {
      return undefined;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return undefined;
    }
    const stash = snapshot.stashes?.find((candidate) => candidate.ref === ref);
    if (!stash) {
      void vscode.window.showWarningMessage('That stash is no longer available. Refresh the repository and try again.');
      return undefined;
    }
    return stash;
  }

  private async handleStashChanges(): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    if (!(await this.gitService.hasWorkingTreeChanges(snapshot.repoRoot))) {
      void vscode.window.showInformationMessage('No local changes to stash.');
      return;
    }
    const tracked = 'Stash tracked changes';
    const includingUntracked = 'Stash including untracked files (-u)';
    const selectFiles = 'Select files to stash...';
    const scope = await vscode.window.showQuickPick(
      [{ label: tracked }, { label: includingUntracked }, { label: selectFiles }],
      {
        title: 'Stash Changes',
        placeHolder: 'Choose which working-tree changes to stash',
        ignoreFocusOut: true,
      },
    );
    if (!scope) {
      return;
    }
    let includeUntracked = scope.label === includingUntracked;
    let paths: string[] | undefined;
    if (scope.label === selectFiles) {
      const files = await this.gitService.getWorkingTreeFiles(snapshot.repoRoot);
      if (files.length === 0) {
        void vscode.window.showInformationMessage('No local changes to stash.');
        return;
      }
      const items = files.map((file) => ({
        label: file.path,
        description: this.describeWorkingTreeFile(file),
        file,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select files to stash',
      });
      if (!selected || selected.length === 0) {
        return;
      }
      includeUntracked = selected.some((item) => item.file.untracked);
      paths = [...new Set(selected.flatMap((item) =>
        item.file.originalPath === undefined
          ? [item.file.path]
          : [item.file.originalPath, item.file.path],
      ))];
    }
    const message = await vscode.window.showInputBox({
      title: 'Stash Changes',
      prompt: 'Optional stash message (leave blank for Git’s default message)',
      placeHolder: 'Message',
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    const success = await this.runGitOperation('Stashing changes', (root) =>
      this.gitService.stashPush(root, {
        includeUntracked,
        ...(message.trim() === '' ? {} : { message }),
        ...(paths === undefined ? {} : { paths }),
      }),
    );
    if (success) {
      void vscode.window.showInformationMessage('Changes stashed.');
    }
  }

  private describeWorkingTreeFile(file: WorkingTreeFile): string {
    if (file.untracked) {
      return 'Untracked';
    }
    const statuses = `${file.indexStatus}${file.worktreeStatus}`;
    const names: Record<string, string> = {
      A: 'Added',
      M: 'Modified',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      U: 'Unmerged',
      T: 'Type changed',
    };
    return [...new Set(statuses.split('').filter((status) => status !== ' ').map(
      (status) => names[status] ?? `Status ${status}`,
    ))].join(', ') || 'Changed';
  }

  private async handleInspectStash(ref: string, hash: string): Promise<void> {
    const stash = this.requireSnapshotStash(ref);
    if (!stash || stash.hash.toLowerCase() !== hash.toLowerCase()) {
      if (stash) {
        void vscode.window.showWarningMessage('That stash changed. Refresh the repository and try again.');
      }
      return;
    }
    this.host.openPanel();
    this.revealCommit(stash.hash);
  }

  private warnOnStashConflict(err: unknown): void {
    const text =
      err instanceof GitExecutionError
        ? `${err.stderr}\n${err.message}`
        : describeError(err);
    if (/conflict|unmerged/i.test(text)) {
      void vscode.window.showWarningMessage('The stash was applied with merge conflicts. Resolve the conflicts before continuing.');
    }
  }

  private async handleApplyStash(ref: string): Promise<void> {
    const stash = this.requireSnapshotStash(ref);
    if (!stash) {
      return;
    }
    await this.runGitOperation(
      `Applying ${stash.ref}`,
      (root) => this.gitService.applyStash(root, stash.ref),
      undefined,
      (err) => this.warnOnStashConflict(err),
    );
  }

  private async handlePopStash(ref: string): Promise<void> {
    const stash = this.requireSnapshotStash(ref);
    if (!stash) {
      return;
    }
    await this.runGitOperation(
      `Popping ${stash.ref}`,
      (root) => this.gitService.popStash(root, stash.ref),
      undefined,
      (err) => this.warnOnStashConflict(err),
    );
  }

  private async handleDropStash(ref: string): Promise<void> {
    const stash = this.requireSnapshotStash(ref);
    if (!stash) {
      return;
    }
    const drop = 'Drop Stash';
    const choice = await vscode.window.showQuickPick(
      [{ label: drop, description: `${stash.ref}: ${stash.message || stash.hash.slice(0, 8)}` }, { label: 'Cancel' }],
      {
        title: `Drop ${stash.ref}`,
        placeHolder: `${stash.ref}: ${stash.message || stash.hash.slice(0, 8)}`,
        ignoreFocusOut: true,
      },
    );
    if (choice?.label !== drop) {
      return;
    }
    const current = this.requireSnapshotStash(ref);
    if (!current || current.hash !== stash.hash) {
      void vscode.window.showWarningMessage('The stash list changed while confirming. Review the stash and try again.');
      return;
    }
    await this.runGitOperation(`Dropping ${stash.ref}`, (root) => this.gitService.dropStash(root, stash.ref));
  }

  private resolveSnapshotWorktree(target: string | undefined) {
    if (!target || !this.lastSnapshot) {
      return undefined;
    }
    const normalized = canonicalizeRepoPath(target);
    return this.lastSnapshot.worktrees.find(
      (worktree) => canonicalizeRepoPath(worktree.path) === normalized,
    );
  }

  private async handleOpenWorktree(target: string | undefined): Promise<void> {
    const worktree = this.resolveSnapshotWorktree(target);
    if (!worktree) {
      void vscode.window.showWarningMessage('That worktree is not part of the loaded repository.');
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(worktree.path),
      { forceNewWindow: true },
    );
  }

  private async handleCopyWorktreePath(target: string | undefined): Promise<void> {
    const worktree = this.resolveSnapshotWorktree(target);
    if (!worktree) {
      void vscode.window.showWarningMessage('That worktree is not part of the loaded repository.');
      return;
    }
    await vscode.env.clipboard.writeText(worktree.path);
  }

  private async handleRemoveWorktree(target: string | undefined): Promise<void> {
    const snapshot = this.lastSnapshot;
    const worktree = this.resolveSnapshotWorktree(target);
    if (!snapshot || !worktree) {
      void vscode.window.showWarningMessage('That worktree is not part of the loaded repository.');
      return;
    }
    if (worktree.isMain) {
      void vscode.window.showWarningMessage('The main worktree cannot be removed.');
      return;
    }
    if (worktree.isCurrent) {
      void vscode.window.showWarningMessage('The currently open worktree cannot be removed.');
      return;
    }
    const branchLabel = worktree.branchName ?? `detached @ ${worktree.headHash.slice(0, 8)}`;
    const confirmation = await vscode.window.showQuickPick(
      [
        { label: 'Remove Worktree', detail: `${branchLabel}\n${worktree.path}` },
        { label: 'Cancel' },
      ],
      {
        title: `Remove Worktree "${branchLabel}"`,
        placeHolder: `Remove ${worktree.path}?`,
        ignoreFocusOut: true,
      },
    );
    if (confirmation?.label !== 'Remove Worktree') {
      return;
    }

    let removalError: unknown;
    const removed = await this.runGitOperation(
      `Removing worktree ${branchLabel}`,
      (root) => this.gitService.removeWorktree(root, worktree.path, false),
      undefined,
      (error) => {
        removalError = error;
      },
    );
    if (
      removed ||
      !(removalError instanceof GitExecutionError) ||
      !/(modified|untracked|locked|contains modified or untracked files)/i.test(removalError.stderr)
    ) {
      return;
    }
    const forceChoice = await vscode.window.showQuickPick(
      [{ label: 'Force Remove Worktree' }, { label: 'Cancel' }],
      {
        title: `Force Remove Worktree "${branchLabel}"`,
        placeHolder: 'Git could not remove this worktree. Force removal only if you accept losing its uncommitted files.',
        ignoreFocusOut: true,
      },
    );
    if (forceChoice?.label === 'Force Remove Worktree') {
      await this.runGitOperation(
        `Force-removing worktree ${branchLabel}`,
        (root) => this.gitService.removeWorktree(root, worktree.path, true),
      );
    }
  }

  private async handleCreateWorktree(target: string | undefined): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    if (target !== undefined) {
      const branch = snapshot.localBranches.find((candidate) => candidate.name === target);
      if (!branch || branch.worktreePath) {
        void vscode.window.showWarningMessage(
          !branch
            ? `"${target}" is not a local branch in this repository.`
            : `Branch "${target}" is already checked out in worktree: ${branch.worktreePath}`,
        );
        return;
      }
    }
    await this.openCreateWorktreeDialog(snapshot, {
      ...(target === undefined ? {} : { initialBranchName: target }),
      branchLocked: target !== undefined,
    });
  }

  private async readChildDirectoryNames(dirPath: string): Promise<string[]> {
    try {
      return await fs.promises.readdir(dirPath);
    } catch {
      return [];
    }
  }

  private async openCreateWorktreeDialog(
    snapshot: RepoSnapshot,
    options: {
      readonly initialBranchName?: string;
      readonly initialCreateBranch?: boolean;
      readonly branchLocked: boolean;
      readonly startPoint?: string;
    },
  ): Promise<void> {
    const defaultParentPath = path.dirname(snapshot.repoRoot);
    this.pendingCreateWorktreeDialog = {
      repoRoot: snapshot.repoRoot,
      repoName: snapshot.repoName,
      defaultParentPath,
      existingChildNames: await this.readChildDirectoryNames(defaultParentPath),
      availableBranches: snapshot.localBranches
        .filter((branch) => !branch.worktreePath)
        .map((branch) => branch.name),
      allLocalBranchNames: snapshot.localBranches.map((branch) => branch.name),
      ...(options.initialBranchName === undefined ? {} : { initialBranchName: options.initialBranchName }),
      ...(options.initialCreateBranch === undefined ? {} : { initialCreateBranch: options.initialCreateBranch }),
      branchLocked: options.branchLocked,
      ...(options.startPoint === undefined ? {} : { startPoint: options.startPoint }),
    };
    this.host.openPanel();
    this.flushPendingCreateWorktreeDialog();
  }

  private async handleBrowseWorktreeParentFolder(currentParentPath: string | undefined): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    const defaultPath = currentParentPath && path.isAbsolute(currentParentPath)
      ? currentParentPath
      : snapshot === null
        ? undefined
        : path.dirname(snapshot.repoRoot);
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      ...(defaultPath === undefined ? {} : { defaultUri: vscode.Uri.file(defaultPath) }),
      openLabel: 'Select Parent Folder',
    });
    const selectedPath = selected?.[0]?.fsPath;
    const editor = this.surfaces.get('editor');
    if (selectedPath === undefined || editor === undefined) {
      return;
    }
    editor.post({
      type: 'worktreeParentFolderSelected',
      payload: {
        parentFolderPath: selectedPath,
        existingChildNames: await this.readChildDirectoryNames(selectedPath),
      },
    });
  }

  private async handleSubmitCreateWorktree(payload: {
    branchName: string;
    createBranch: boolean;
    startPoint?: string;
    parentFolderPath: string;
    folderName: string;
    openInNewWindow: boolean;
  }): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }

    let branchName: string;
    try {
      branchName = validateGitRef(payload.branchName);
    } catch (err) {
      void vscode.window.showWarningMessage(`Cannot create worktree: ${describeError(err)}`);
      return;
    }

    let startPoint: string | undefined;
    if (payload.startPoint !== undefined) {
      try {
        startPoint = validateGitRef(payload.startPoint);
      } catch (err) {
        void vscode.window.showWarningMessage(`Cannot create worktree: invalid start point (${describeError(err)})`);
        return;
      }
    }

    const branch = snapshot.localBranches.find((candidate) => candidate.name === branchName);
    if (payload.createBranch) {
      if (branch !== undefined) {
        void vscode.window.showWarningMessage(`Branch "${branchName}" already exists.`);
        return;
      }
    } else if (branch === undefined) {
      void vscode.window.showWarningMessage(`"${branchName}" is not a local branch in this repository.`);
      return;
    } else if (branch.worktreePath) {
      void vscode.window.showWarningMessage(
        `Branch "${branchName}" is already checked out in worktree: ${branch.worktreePath}`,
      );
      return;
    }

    const parentFolderPath = payload.parentFolderPath.trim();
    if (!isAbsoluteWorktreePath(parentFolderPath)) {
      void vscode.window.showWarningMessage('The worktree parent folder must be an absolute path.');
      return;
    }
    try {
      const parentStat = await fs.promises.stat(parentFolderPath);
      if (!parentStat.isDirectory()) {
        void vscode.window.showWarningMessage(`The worktree parent folder is not a directory: ${parentFolderPath}`);
        return;
      }
    } catch {
      void vscode.window.showWarningMessage(`The worktree parent folder does not exist: ${parentFolderPath}`);
      return;
    }

    const folderName = payload.folderName;
    if (
      !folderName.trim() ||
      folderName === '.' ||
      folderName.includes('..') ||
      /[/\\]/.test(folderName) ||
      /[<>:"|?*\x00-\x1f]/.test(folderName) ||
      /[. ]$/.test(folderName) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(folderName)
    ) {
      void vscode.window.showWarningMessage('Enter a valid worktree folder name.');
      return;
    }

    const targetPath = resolveWorktreePath(
      `${parentFolderPath.replace(/[\\/]+$/, '')}${isWindowsStylePath(parentFolderPath) ? '\\' : '/'}${folderName}`,
    );
    const normalizedRoot = normalizeWorktreePathForComparison(snapshot.repoRoot);
    const normalizedTarget = normalizeWorktreePathForComparison(targetPath);
    const normalizedRootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRootPrefix)) {
      void vscode.window.showWarningMessage('The new worktree cannot be created inside the repository.');
      return;
    }
    try {
      await fs.promises.stat(targetPath);
      void vscode.window.showWarningMessage(`That path already exists: ${targetPath}`);
      return;
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String(err.code) : '';
      if (code !== 'ENOENT') {
        void vscode.window.showWarningMessage(`Could not verify the worktree destination: ${targetPath}`);
        return;
      }
    }

    const created = await this.runGitOperation(`Creating worktree for ${branchName}`, (root) =>
      this.gitService.addWorktree(root, targetPath, {
        branchName,
        createBranch: payload.createBranch,
        startPoint,
      }),
    );
    if (created && payload.openInNewWindow) {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(targetPath),
        { forceNewWindow: true },
      );
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
    const found = listRefTargets(snapshot).find(
      (target) => (target.name === ref || target.fullName === ref) && kinds.includes(target.kind),
    );
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

  private async handleCherryPickIntoWorktree(hash: string | undefined): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    if (!isValidCommitHash(hash)) {
      return;
    }
    const lower = hash.toLowerCase();
    const commit = snapshot.commits.find((candidate) => candidate.hash === lower);
    if (!commit) {
      void vscode.window.showWarningMessage('That commit is not part of the loaded history.');
      return;
    }
    if (commit.parents.length > 1) {
      void vscode.window.showWarningMessage('Merge commits cannot be cherry-picked.');
      return;
    }

    const eligibleWorktrees = snapshot.worktrees.filter(
      (worktree) => !worktree.isCurrent && !worktree.isBare && !worktree.isLocked && !worktree.isPrunable,
    );
    if (eligibleWorktrees.length === 0) {
      void vscode.window.showWarningMessage('No other unlocked, active worktrees are available.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      eligibleWorktrees.map((worktree) => ({
        label: worktree.branchName ?? `Detached HEAD (${worktree.headHash.slice(0, 8)})`,
        description: worktree.isMain ? 'Main worktree' : 'Linked worktree',
        detail: worktree.path,
        worktree,
      })),
      {
        title: 'Cherry-Pick into Worktree',
        placeHolder: `Select destination worktree for ${commit.shortHash}`,
        ignoreFocusOut: true,
      },
    );
    if (!selected) {
      return;
    }

    const targetWorktree = this.resolveSnapshotWorktree(selected.worktree.path);
    if (!targetWorktree) {
      void vscode.window.showWarningMessage('That worktree is not part of the loaded repository.');
      return;
    }
    const targetLabel =
      targetWorktree.branchName ?? `Detached HEAD (${targetWorktree.headHash.slice(0, 8)})`;
    const openWorktreeLabel = 'Open Worktree in New Window';
    const openWorktree = async (): Promise<void> => {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(targetWorktree.path),
        { forceNewWindow: true },
      );
    };

    const isDirty = await this.gitService.hasWorkingTreeChanges(targetWorktree.path);
    if (isDirty) {
      const choice = await vscode.window.showWarningMessage(
        `Cannot cherry-pick into "${targetLabel}" because it has uncommitted changes. Commit or stash changes there first.`,
        openWorktreeLabel,
      );
      if (choice === openWorktreeLabel) {
        await openWorktree();
      }
      return;
    }

    let gitOperationFailed = false;
    const succeeded = await this.runGitOperation(
      `Cherry-picking ${commit.shortHash} into ${targetLabel}`,
      () => this.gitService.cherryPickCommit(targetWorktree.path, lower),
      'If conflicts occurred in that worktree, open it to resolve them or run git cherry-pick --abort.',
      () => {
        gitOperationFailed = true;
      },
      true,
    );
    if (!succeeded) {
      if (gitOperationFailed) {
        const choice = await vscode.window.showWarningMessage(
          `Open "${targetLabel}" to inspect or resolve the failed cherry-pick.`,
          openWorktreeLabel,
        );
        if (choice === openWorktreeLabel) {
          await openWorktree();
        }
      }
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `Cherry-picked ${commit.shortHash} into ${targetLabel}.`,
      openWorktreeLabel,
    );
    if (choice === openWorktreeLabel) {
      await openWorktree();
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
    if (target.branch?.worktreePath) {
      void vscode.window.showWarningMessage(
        `Branch "${target.name}" is already checked out in another worktree: ${target.branch.worktreePath}`,
      );
      return;
    }
    const deleteLabel = `Delete Branch "${target.name}"`;
    const choice = await vscode.window.showQuickPick(
      [
        { label: deleteLabel, detail: 'Permanently deletes this local branch. This cannot be undone.' },
        { label: 'Cancel' },
      ],
      {
        title: `Delete Branch "${target.name}"`,
        placeHolder:
          `Warning: You are about to permanently delete local branch "${target.name}". This action cannot be undone.`,
        ignoreFocusOut: true,
      },
    );
    if (choice?.label !== deleteLabel) {
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
    const force = `Force Delete Branch "${target.name}"`;
    const forceChoice = await vscode.window.showQuickPick(
      [
        { label: force, detail: 'Permanently deletes this unmerged local branch. This action cannot be undone.' },
        { label: 'Cancel' },
      ],
      {
        title: `Force Delete Branch "${target.name}"`,
        placeHolder:
          `"${target.name}" is not fully merged. Force-delete it and lose its unmerged commits? This action cannot be undone.`,
        ignoreFocusOut: true,
      },
    );
    if (forceChoice?.label === force) {
      await this.runGitOperation(`Force-deleting branch ${target.name}`, (root) =>
        this.gitService.deleteLocalBranch(root, target.name, true),
      );
    }
  }

  private async handleCreateTag(targetHash: string | undefined): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    if (!isValidCommitHash(targetHash)) {
      void vscode.window.showWarningMessage('Select a valid commit before creating a tag.');
      return;
    }
    const normalizedHash = targetHash.toLowerCase();
    const tagNames = new Set(snapshot.tags.map((tag) => tag.name));
    const input = await vscode.window.showInputBox({
      title: 'Create Tag',
      placeHolder: 'e.g. v1.8.1',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const tagName = validateGitRef(value);
          return tagNames.has(tagName) ? `A tag named "${tagName}" already exists.` : undefined;
        } catch (err) {
          return describeError(err);
        }
      },
    });
    if (input === undefined) {
      return;
    }
    let tagName: string;
    try {
      tagName = validateGitRef(input);
    } catch (err) {
      void vscode.window.showWarningMessage(`Cannot create tag: ${describeError(err)}`);
      return;
    }
    if (tagNames.has(tagName)) {
      void vscode.window.showWarningMessage(`A tag named "${tagName}" already exists.`);
      return;
    }
    const message = await vscode.window.showInputBox({
      title: 'Tag Message (Optional)',
      placeHolder: 'Leave blank for a lightweight tag',
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    const succeeded = await this.runGitOperation(
      `Creating tag ${tagName}`,
      (root) => this.gitService.createTag(root, tagName, normalizedHash, message),
    );
    if (succeeded) {
      void vscode.window.showInformationMessage(`Created tag "${tagName}".`);
    }
  }

  private async handleDeleteTag(tagName: string | undefined): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    let validatedName: string;
    try {
      validatedName = validateGitRef(tagName ?? '');
    } catch (err) {
      void vscode.window.showWarningMessage(`Cannot delete tag: ${describeError(err)}`);
      return;
    }
    if (!snapshot.tags.some((tag) => tag.name === validatedName)) {
      void vscode.window.showWarningMessage(`Tag "${validatedName}" is not available in the loaded repository.`);
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'Delete Tag',
          detail: 'Removes the local tag only. Remote tags are not affected.',
        },
        { label: 'Cancel' },
      ],
      {
        title: 'Delete Local Tag',
        placeHolder: `Delete local tag "${validatedName}"?`,
        ignoreFocusOut: true,
      },
    );
    if (choice?.label !== 'Delete Tag') {
      return;
    }
    await this.runGitOperation(
      `Deleting tag ${validatedName}`,
      (root) => this.gitService.deleteLocalTag(root, validatedName),
    );
  }

  private async handlePushTag(tagName: string | undefined): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      void vscode.window.showWarningMessage('No Git repository is loaded.');
      return;
    }
    let validatedName: string;
    try {
      validatedName = validateGitRef(tagName ?? '');
    } catch (err) {
      void vscode.window.showWarningMessage(`Cannot push tag: ${describeError(err)}`);
      return;
    }
    if (!snapshot.tags.some((tag) => tag.name === validatedName)) {
      void vscode.window.showWarningMessage(`Tag "${validatedName}" is not available in the loaded repository.`);
      return;
    }
    const remotes = this.getRemoteNames(snapshot);
    if (remotes.length === 0) {
      void vscode.window.showWarningMessage('No remotes configured to push this tag.');
      return;
    }
    let remoteName = remotes[0] ?? '';
    if (remotes.length > 1) {
      const options = remotes.map((name) => {
        const group = snapshot.remoteGroups.find((candidate) => candidate.remoteName === name);
        return {
          label: name,
          ...(group?.providerName ? { description: group.providerName } : {}),
          ...(group?.url ? { detail: group.url } : {}),
          remoteName: name,
        };
      });
      const selected = await vscode.window.showQuickPick(options, {
        title: 'Push Tag to Remote',
        placeHolder: `Choose a destination for tag "${validatedName}"`,
        ignoreFocusOut: true,
      });
      if (!selected) {
        return;
      }
      remoteName = selected.remoteName;
    }
    const succeeded = await this.runGitOperation(
      `Pushing tag ${validatedName} to ${remoteName}`,
      (root) => this.gitService.pushTag(root, remoteName, validatedName),
    );
    if (succeeded) {
      void vscode.window.showInformationMessage(`Pushed tag "${validatedName}" to "${remoteName}".`);
    }
  }

  private async handleSearchCommitsByFile(query: string, requestId: number): Promise<void> {
    const empty = (): void => {
      this.surfaces.get('editor')?.post({
        type: 'fileSearchResults',
        payload: { query, requestId, matchingHashes: [] },
      });
    };
    if (!vscode.workspace.isTrusted) {
      empty();
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      empty();
      return;
    }
    try {
      const matchingHashes = await this.gitService.searchCommitsByFile(
        snapshot.repoRoot,
        query,
        Math.max(500, snapshot.commits.length),
      );
      this.surfaces.get('editor')?.post({
        type: 'fileSearchResults',
        payload: { query, requestId, matchingHashes },
      });
    } catch {
      empty();
    }
  }

  private async handleUntrackBranch(branchName: string | undefined): Promise<void> {
    const target = this.resolveRef(branchName, ['local']);
    if (!target?.branch?.upstream) {
      if (target) {
        void vscode.window.showWarningMessage(`Branch "${target.name}" is not tracking a remote branch.`);
      }
      return;
    }
    await this.runGitOperation(`Untracking ${target.name}`, (root) =>
      this.gitService.unsetBranchUpstream(root, target.name),
    );
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

  private async handlePush(targetBranchName?: string, openPrAfterPush = false): Promise<void> {
    const snapshot = this.lastSnapshot;
    const branch = targetBranchName === undefined
      ? snapshot?.localBranches.find((candidate) => candidate.isCurrent)
      : snapshot?.localBranches.find((candidate) => candidate.name === targetBranchName);
    if (!snapshot || !branch || (targetBranchName === undefined && snapshot.isDetachedHead)) {
      void vscode.window.showWarningMessage(
        targetBranchName === undefined
          ? 'Check out a branch before pushing.'
          : `"${targetBranchName}" is not a local branch in this repository.`,
      );
      return;
    }

    const knownRemotes = this.getRemoteNames(snapshot);
    const upstream = branch.upstream ? parseUpstreamRef(branch.upstream, knownRemotes) : null;
    const mismatch = upstream !== null && upstream.remoteBranch !== branch.name;
    let pushed: { remoteName: string; remoteBranchName: string } | null = null;
    let pushOperation: ((repoRoot: string) => Promise<void>) | null = null;
    let title = `Pushing ${branch.name}`;

    if (!upstream || branch.upstreamGone) {
      if (knownRemotes.length === 0) {
        await this.offerRepositoryRemoteSetup();
        return;
      }
      const remoteName = await this.pickRemoteName(snapshot);
      if (remoteName === null) {
        return;
      }
      const destination = await this.getRemoteDestinationInfo(snapshot.repoRoot, remoteName);
      const create = `Create Remote Branch "${remoteName}/${branch.name}"`;
      const publishToGitHub = 'Create & Publish Repository on GitHub…';
      const choice = await vscode.window.showQuickPick(
        [
          { label: create, detail: `Destination: ${destination.displayLabel}` },
          ...(destination.kind === 'localPath'
            ? [{
                label: publishToGitHub,
                detail: `Create a new cloud GitHub repository and push '${branch.name}' there instead of only to the local drive`,
              }]
            : []),
          { label: 'Cancel' },
        ],
        {
          title: 'Publish Branch to Remote',
          placeHolder: `Branch "${branch.name}" does not exist on "${remoteName}" yet`,
          ignoreFocusOut: true,
        },
      );
      if (choice?.label === publishToGitHub) {
        await this.publishBranchToGitHub(branch.name);
        return;
      }
      if (choice?.label !== create) {
        return;
      }
      title = `Publishing ${branch.name} to ${remoteName}`;
      pushed = { remoteName, remoteBranchName: branch.name };
      pushOperation = (root) => this.gitService.pushToRemoteBranch(root, remoteName, branch.name, branch.name, true);
    } else if (mismatch) {
      const selection = await this.chooseRenamedBranchPush(branch, upstream);
      if (selection === null) {
        return;
      }
      pushed = selection;
      pushOperation = (root) =>
        this.gitService.pushToRemoteBranch(
          root,
          selection.remoteName,
          branch.name,
          selection.remoteBranchName,
          selection.remoteBranchName === branch.name,
        );
    } else {
      const isCurrent = branch.isCurrent;
      pushed = { remoteName: upstream.remoteName, remoteBranchName: branch.name };
      pushOperation = (root) => {
        if (isCurrent) {
          return this.gitService.pushCurrentBranch(root, branch.name, true);
        }
        return this.gitService.pushToRemoteBranch(root, upstream.remoteName, branch.name, branch.name, false);
      };
    }

    if (openPrAfterPush && pushed) {
      const defaultBranch = snapshot.remoteGroups.find(
        (group) => group.remoteName === pushed?.remoteName,
      )?.defaultBranch;
      if (defaultBranch !== undefined && defaultBranch === pushed.remoteBranchName) {
        void vscode.window.showInformationMessage(
          `Cannot create a pull request from the default branch (${defaultBranch}).`,
        );
        return;
      }
    }

    let recoveryCancelled = false;
    const succeeded = await this.runGitOperation(title, async (root) => {
      try {
        await pushOperation?.(root);
      } catch (err) {
        const errorText = `${describeError(err)} ${err instanceof GitExecutionError ? err.stderr : ''}`;
        if (mismatch || !upstream || !isUpstreamMismatchError(errorText)) {
          throw err;
        }
        const selection = await this.chooseRenamedBranchPush(branch, upstream);
        if (selection === null) {
          recoveryCancelled = true;
          return;
        }
        pushed = selection;
        await this.gitService.pushToRemoteBranch(
          root,
          selection.remoteName,
          branch.name,
          selection.remoteBranchName,
          selection.remoteBranchName === branch.name,
        );
      }
    });
    if (!succeeded || recoveryCancelled || pushed === null) {
      return;
    }
    await this.handlePostPushPr(pushed, openPrAfterPush);
  }

  private async pickRemoteName(snapshot: RepoSnapshot): Promise<string | null> {
    const remotes = this.getRemoteNames(snapshot);
    if (remotes.length === 0) {
      return null;
    }
    if (remotes.length === 1) {
      return remotes[0] ?? null;
    }
    const selected = await vscode.window.showQuickPick(remotes, {
      placeHolder: 'Choose a remote for the new branch',
      title: 'Push to Remote',
    });
    return selected ?? null;
  }

  private getRemoteNames(snapshot: RepoSnapshot): string[] {
    return [...new Set([...(snapshot.remotes ?? []), ...snapshot.remoteGroups.map((group) => group.remoteName)])];
  }

  private async offerRepositoryRemoteSetup(): Promise<void> {
    await this.handlePublishRepository();
  }

  private async handlePublishRepository(): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || snapshot.isDetachedHead) {
      void vscode.window.showWarningMessage('Check out a branch before publishing this repository.');
      return;
    }
    const publish = 'Create & Publish Repository on GitHub…';
    const local = 'Create Local Bare Remote on Disk…';
    const addRemote = 'Add Existing Remote URL (origin)…';
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: publish,
          detail: 'Choose Personal Account or Organization, visibility, and confirm target URL',
        },
        {
          label: local,
          detail: 'Choose a folder on a local or network drive to initialize a bare Git remote',
        },
        {
          label: addRemote,
          detail: 'Attach an existing remote URL and push',
        },
        { label: 'Cancel' },
      ],
      {
        title: 'Publish Repository / Add Remote',
        ignoreFocusOut: true,
      },
    );
    if (choice?.label === publish) {
      await this.publishBranchToGitHub(snapshot.currentBranch);
    } else if (choice?.label === local) {
      await this.createLocalBareRemote(snapshot.currentBranch);
    } else if (choice?.label === addRemote) {
      await this.addOriginRemoteManually(snapshot.currentBranch);
    }
  }

  private async publishBranchToGitHub(branchName: string): Promise<void> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await this.githubService.getPublishSession();
    } catch {
      return;
    }
    if (!session) {
      return;
    }

    let owners;
    try {
      owners = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading GitHub publish destinations…' },
        () => this.githubService.listPublishOwners(session!.accessToken),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not load GitHub accounts: ${describeError(err)}`);
      return;
    }
    const ownerChoice = await vscode.window.showQuickPick(
      owners.map((owner) => ({
        label: `${owner.login} (${owner.type === 'user' ? 'Personal Account' : 'Organization'})`,
        ownerLogin: owner.login,
        ownerType: owner.type,
      })),
      {
        title: 'Publish Repository to GitHub (1/4): Select Owner',
        ignoreFocusOut: true,
      },
    );
    if (!ownerChoice) {
      return;
    }
    const visibility = await vscode.window.showQuickPick(
      [
        { label: 'Private Repository', description: 'Recommended', isPrivate: true },
        { label: 'Public Repository', isPrivate: false },
      ],
      {
        title: 'Publish Repository to GitHub (2/4): Visibility',
        ignoreFocusOut: true,
      },
    );
    if (!visibility) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    const repoName = await vscode.window.showInputBox({
      title: 'Publish Repository to GitHub (3/4): Repository Name',
      value: path.basename(snapshot.repoRoot),
      ignoreFocusOut: true,
      validateInput: validateGitHubRepoName,
    });
    if (repoName === undefined) {
      return;
    }
    const name = repoName.trim();
    const targetUrl = `https://github.com/${ownerChoice.ownerLogin}/${name}`;
    const confirm = `Create Repository & Push '${branchName}'`;
    const confirmation = await vscode.window.showQuickPick(
      [
        {
          label: confirm,
          detail: `Target: ${targetUrl} (${visibility.isPrivate ? 'Private' : 'Public'})`,
        },
        { label: 'Cancel' },
      ],
      {
        title: 'Publish Repository to GitHub (4/4): Confirm',
        ignoreFocusOut: true,
      },
    );
    if (confirmation?.label !== confirm) {
      return;
    }

    let created;
    try {
      created = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating GitHub repository…' },
        () => this.githubService.createRepository(session!.accessToken, {
          ownerLogin: ownerChoice.ownerLogin,
          ownerType: ownerChoice.ownerType,
          name,
          isPrivate: visibility.isPrivate,
        }),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not create GitHub repository: ${describeError(err)}`);
      return;
    }

    const remoteNames = this.getRemoteNames(snapshot);
    const remoteName = !remoteNames.includes('origin')
      ? 'origin'
      : !remoteNames.includes('github')
        ? 'github'
        : 'github-origin';
    const succeeded = await this.runGitOperation(`Publishing ${branchName} to GitHub`, async (repoRoot) => {
      await this.gitService.addRemote(repoRoot, remoteName, created.cloneUrl);
      await this.gitService.pushToRemoteBranch(repoRoot, remoteName, branchName, branchName, true);
    });
    if (!succeeded) {
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `Published '${branchName}' to ${created.fullName}.`,
      'Open on GitHub',
    );
    if (action === 'Open on GitHub') {
      await this.openHttpsUrl(created.htmlUrl);
    }
  }

  private async createLocalBareRemote(branchName: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    const [parent] = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Parent Folder for Bare Remote',
      title: 'Create Local Bare Remote (1/2): Choose Parent Folder',
    }) ?? [];
    if (!parent) {
      return;
    }
    const folderNameInput = await vscode.window.showInputBox({
      title: 'Create Local Bare Remote (2/2): Folder Name',
      value: `${path.basename(snapshot.repoRoot)}.git`,
      ignoreFocusOut: true,
      validateInput: validateLocalBareRepoFolderName,
    });
    if (folderNameInput === undefined) {
      return;
    }
    const folderName = folderNameInput.trim();
    const fullPath = path.join(parent.fsPath, folderName);
    const remoteName = this.getRemoteNames(snapshot).includes('origin') ? 'local-backup' : 'origin';
    const confirm = 'Create Bare Remote & Push';
    const confirmation = await vscode.window.showQuickPick(
      [
        {
          label: confirm,
          detail: `Destination: ${fullPath} (remote: ${remoteName})`,
        },
        { label: 'Cancel' },
      ],
      {
        title: 'Create Local Bare Remote: Confirm Destination',
        ignoreFocusOut: true,
      },
    );
    if (confirmation?.label !== confirm) {
      return;
    }
    const succeeded = await this.runGitOperation(`Creating local bare remote ${folderName}`, async (repoRoot) => {
      await this.gitService.initBareRepository(fullPath, branchName);
      await this.gitService.addRemote(repoRoot, remoteName, fullPath);
      await this.gitService.pushToRemoteBranch(repoRoot, remoteName, branchName, branchName, true);
    });
    if (succeeded) {
      void vscode.window.showInformationMessage(`Created local bare remote at ${fullPath}.`);
    }
  }

  private async addOriginRemoteManually(branchName?: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: 'Add Remote "origin"',
      placeHolder: 'https://github.com/user/repo.git',
      ignoreFocusOut: true,
      validateInput: (value) => this.validateRemoteUrlInput(value),
    });
    if (input === undefined) {
      return;
    }
    const validationError = this.validateRemoteUrlInput(input);
    if (validationError !== undefined) {
      void vscode.window.showWarningMessage(validationError);
      return;
    }
    await this.runGitOperation('Adding remote origin', async (root) => {
      await this.gitService.addRemote(root, 'origin', input);
      if (branchName !== undefined) {
        await this.gitService.pushToRemoteBranch(root, 'origin', branchName, branchName, true);
      }
    });
  }

  private validateRemoteUrlInput(value: string): string | undefined {
    const url = value.trim();
    if (url.length === 0) {
      return 'Enter a remote URL or path.';
    }
    if (url.startsWith('-')) {
      return 'A remote URL or path cannot start with "-".';
    }
    if (/[\x00-\x1f\x7f]/.test(url)) {
      return 'A remote URL or path cannot contain control characters.';
    }
    if (/\s/.test(url) && classifyRemoteDestination(url).kind !== 'localPath') {
      return 'A remote URL cannot contain whitespace.';
    }
    if (/^ext::/i.test(url)) {
      return 'The ext:: transport is not allowed.';
    }
    return undefined;
  }

  private async chooseRenamedBranchPush(
    branch: BranchInfo,
    upstream: { remoteName: string; remoteBranch: string },
  ): Promise<{ remoteName: string; remoteBranchName: string } | null> {
    const createNew = `Create New Remote Branch (${upstream.remoteName}/${branch.name})`;
    const useExisting = `Push to Existing Remote Branch (${upstream.remoteName}/${upstream.remoteBranch})`;
    const publishToGitHub = 'Create & Publish Repository on GitHub…';
    const snapshot = this.lastSnapshot;
    const destination = snapshot
      ? await this.getRemoteDestinationInfo(snapshot.repoRoot, upstream.remoteName)
      : null;
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: createNew,
          detail: `Destination: ${destination?.displayLabel ?? upstream.remoteName}. Creates the renamed remote branch and updates upstream tracking`,
        },
        {
          label: useExisting,
          detail: `Destination: ${destination?.displayLabel ?? upstream.remoteName}. Pushes commits onto the old remote branch name`,
        },
        ...(destination?.kind === 'localPath'
          ? [{
              label: publishToGitHub,
              detail: `Create a new cloud GitHub repository and push '${branch.name}' there instead of only to the local drive`,
            }]
          : []),
        { label: 'Cancel' },
      ],
      {
        title: 'Remote Branch Name Mismatch',
        placeHolder: `Local branch "${branch.name}" tracks "${upstream.remoteName}/${upstream.remoteBranch}"`,
        ignoreFocusOut: true,
      },
    );
    if (choice?.label === publishToGitHub) {
      await this.publishBranchToGitHub(branch.name);
      return null;
    }
    if (choice?.label === createNew) {
      return { remoteName: upstream.remoteName, remoteBranchName: branch.name };
    }
    if (choice?.label === useExisting) {
      return { remoteName: upstream.remoteName, remoteBranchName: upstream.remoteBranch };
    }
    return null;
  }

  private async getRemoteDestinationInfo(repoRoot: string, remoteName: string) {
    const rawUrl = await this.gitService.getRemoteRawUrl(repoRoot, remoteName);
    return classifyRemoteDestination(rawUrl ?? remoteName);
  }

  private async handlePostPushPr(
    pushed: { remoteName: string; remoteBranchName: string },
    openImmediately: boolean,
  ): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    const remote = await this.resolveRemoteHost(snapshot.repoRoot, pushed.remoteName);
    if (!remote) {
      if (openImmediately) {
        void vscode.window.showInformationMessage(`The "${pushed.remoteName}" remote uses an unsupported hosting provider.`);
      }
      return;
    }
    const url = buildRemoteCreatePrUrl(remote, pushed.remoteBranchName);
    if (!url) {
      return;
    }
    if (openImmediately) {
      await this.openHttpsUrl(url);
    } else if (!isDefaultBranchName(pushed.remoteBranchName)) {
      const choice = await vscode.window.showInformationMessage(
        `Pushed "${pushed.remoteBranchName}" to ${pushed.remoteName}.`,
        'Create PR in Browser',
      );
      if (choice === 'Create PR in Browser') {
        await this.openHttpsUrl(url);
      }
    }
  }

  private openCreateBranchDialog(startPoint?: string, requestedKind?: CreateBranchSourceKind): void {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }

    let sourceKind: CreateBranchSourceKind = requestedKind ?? 'head';
    let resolvedStartPoint: string | undefined;
    let startLabel = snapshot.isDetachedHead ? 'HEAD' : snapshot.currentBranch;
    let initialName = '';
    let remoteTrackingRef: string | undefined;

    if (startPoint !== undefined) {
      if (isValidCommitHash(startPoint)) {
        const hash = startPoint.toLowerCase();
        if (requestedKind !== undefined && requestedKind !== 'commit') {
          return;
        }
        if (!snapshot.commits.some((commit) => commit.hash === hash)) {
          void vscode.window.showWarningMessage('That commit is not part of the loaded history.');
          return;
        }
        sourceKind = 'commit';
        resolvedStartPoint = hash;
        startLabel = hash.slice(0, 8);
      } else {
        const target = listRefTargets(snapshot).find(
          (candidate) =>
            (requestedKind === undefined ||
              (requestedKind === 'remote' && candidate.kind === 'remote') ||
              (requestedKind === 'local' && candidate.kind === 'local') ||
              (requestedKind === 'tag' && candidate.kind === 'tag')) &&
            (candidate.name === startPoint || candidate.fullName === startPoint),
        );
        if (!target) {
          void vscode.window.showWarningMessage(`"${startPoint}" is not a known ref in this repository.`);
          return;
        }
        const targetKind = target.kind;
        if (
          (targetKind === 'remote' && requestedKind !== undefined && requestedKind !== 'remote') ||
          (targetKind === 'local' && requestedKind !== undefined && requestedKind !== 'local') ||
          (targetKind === 'tag' && requestedKind !== undefined && requestedKind !== 'tag')
        ) {
          return;
        }
        sourceKind = targetKind;
        resolvedStartPoint = target.fullName;
        startLabel = target.name;
        if (target.kind === 'remote' && target.branch) {
          initialName = extractShortRemoteBranchName(target.name, target.branch.remoteName ?? undefined);
          remoteTrackingRef = target.name;
        } else if (target.kind === 'local' && target.branch) {
          initialName = target.branch.name;
        }
      }
    } else if (requestedKind !== undefined && requestedKind !== 'head') {
      return;
    }

    this.pendingCreateBranchDialog = {
      sourceKind,
      ...(resolvedStartPoint === undefined ? {} : { startPoint: resolvedStartPoint }),
      startLabel,
      initialName,
      ...(remoteTrackingRef === undefined ? {} : { remoteTrackingRef }),
      existingLocalBranches: snapshot.localBranches.map((branch) => branch.name),
    };
    this.host.openPanel();
    this.flushPendingCreateBranchDialog();
  }

  private async handleSubmitCreateBranch(
    payload: { branchName: string; startPoint?: string; checkout: boolean; track: boolean },
  ): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot) {
      return;
    }
    if (this.operationInProgress) {
      void vscode.window.showWarningMessage('Another Git operation is already running.');
      return;
    }

    let name: string;
    try {
      name = validateGitRef(payload.branchName);
    } catch (err) {
      void vscode.window.showWarningMessage(`Cannot create branch: ${describeError(err)}`);
      return;
    }
    if (snapshot.localBranches.some((branch) => branch.name === name)) {
      void vscode.window.showWarningMessage(`Branch "${name}" already exists.`);
      return;
    }

    const startTarget = payload.startPoint === undefined
      ? null
      : isValidCommitHash(payload.startPoint)
        ? { target: payload.startPoint.toLowerCase(), kind: 'commit' as const }
        : (() => {
            const target = listRefTargets(snapshot).find(
              (candidate) => candidate.name === payload.startPoint || candidate.fullName === payload.startPoint,
            );
            return target === undefined ? null : { target: target.name, kind: target.kind };
          })();
    if (payload.startPoint !== undefined && startTarget === null) {
      void vscode.window.showWarningMessage(`"${payload.startPoint}" is not a known ref or commit in this repository.`);
      return;
    }
    if (startTarget?.kind === 'commit' && !snapshot.commits.some((commit) => commit.hash === startTarget.target)) {
      void vscode.window.showWarningMessage('That commit is not part of the loaded history.');
      return;
    }
    const track = payload.track && startTarget?.kind === 'remote';
    const resolvedStartPoint = startTarget?.target;

    let dirtyAction: DirtyWorktreeAction = 'bring';
    if (payload.checkout) {
      try {
        if (await this.gitService.hasWorkingTreeChanges(snapshot.repoRoot)) {
          const choice = await vscode.window.showQuickPick(
            [
              {
                label: 'Bring Changes to New Branch',
                detail: 'Keep uncommitted files in your working tree on the new branch',
              },
              {
                label: 'Stash Changes & Switch',
                detail: 'Save uncommitted and untracked changes to a Git stash before switching',
              },
              {
                label: 'Discard Changes & Switch',
                detail: 'Permanently discard all uncommitted and untracked changes (cannot be undone)',
              },
              {
                label: 'Leave Changes Here & Create Worktree…',
                detail: 'Keep uncommitted files here and create the new branch in a separate worktree',
              },
              { label: 'Cancel' },
            ],
            {
              title: 'Uncommitted Changes Detected',
              placeHolder:
                `Choose what to do with your uncommitted changes before switching to "${name}"`,
              ignoreFocusOut: true,
            },
          );
          dirtyAction =
            choice?.label === 'Bring Changes to New Branch'
              ? 'bring'
              : choice?.label === 'Stash Changes & Switch'
                ? 'stash'
                : choice?.label === 'Discard Changes & Switch'
                  ? 'discard'
                  : choice?.label === 'Leave Changes Here & Create Worktree…'
                    ? 'leaveInWorktree'
                    : 'cancel';
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not inspect the working tree: ${describeError(err)}`);
        return;
      }
    }
    if (dirtyAction === 'cancel') {
      return;
    }
    if (dirtyAction === 'leaveInWorktree') {
      await this.openCreateWorktreeDialog(snapshot, {
        initialBranchName: name,
        initialCreateBranch: true,
        branchLocked: true,
        ...(resolvedStartPoint === undefined ? {} : { startPoint: resolvedStartPoint }),
      });
      return;
    }
    if (dirtyAction === 'discard') {
      const discard = 'Yes, Discard All Changes';
      const confirmation = await vscode.window.showQuickPick(
        [{ label: discard }, { label: 'Cancel' }],
        {
          title: 'Confirm Permanent Discard',
          placeHolder: 'Permanently discard all uncommitted and untracked changes? This action cannot be undone.',
          ignoreFocusOut: true,
        },
      );
      if (confirmation?.label !== discard) {
        return;
      }
    }

    await this.runGitOperation(`Creating branch ${name}`, async (repoRoot) => {
      if (dirtyAction === 'stash') {
        await this.gitService.stashChanges(repoRoot, `Auto-stash before creating ${name}`);
      } else if (dirtyAction === 'discard') {
        await this.gitService.discardWorkingTreeChanges(repoRoot);
      }
      await this.gitService.createBranch(repoRoot, name, resolvedStartPoint, {
        checkout: payload.checkout,
        track,
      });
    });
  }

  private async handleRenameBranch(target: string | undefined): Promise<void> {
    const snapshot = this.lastSnapshot;
    const oldBranch = target === undefined
      ? undefined
      : snapshot?.localBranches.find((branch) => branch.name === target);
    if (!snapshot || !oldBranch) {
      void vscode.window.showWarningMessage('That local branch is not available to rename.');
      return;
    }
    const oldName = oldBranch.name;
    const input = await vscode.window.showInputBox({
      title: 'Rename Branch',
      prompt: `Rename "${oldName}"`,
      value: oldName,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          return 'Branch name is required.';
        }
        try {
          const newName = validateGitRef(trimmed);
          if (newName === oldName) {
            return 'Enter a different branch name.';
          }
          if (snapshot.localBranches.some((branch) => branch.name === newName)) {
            return `Branch "${newName}" already exists.`;
          }
          return null;
        } catch (err) {
          return describeError(err);
        }
      },
    });
    if (input === undefined) {
      return;
    }
    const newName = validateGitRef(input);
    if (newName === oldName) {
      return;
    }
    await this.runGitOperation(`Renaming branch ${oldName}`, (repoRoot) =>
      this.gitService.renameLocalBranch(repoRoot, oldName, newName),
    );
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

  private async openFile(payload: { hash: string; filePath: string; status: string }): Promise<void> {
    if (!this.ensureTrustedWorkspace()) {
      return;
    }
    const snapshot = this.lastSnapshot;
    if (
      !snapshot ||
      !isValidCommitHash(payload.hash) ||
      !isSafeRepoRelativePath(payload.filePath) ||
      !isChangedFileStatus(payload.status)
    ) {
      return;
    }

    const resolvedPath = path.resolve(snapshot.repoRoot, payload.filePath);
    const windowsPaths =
      process.platform === 'win32' ||
      /^[a-zA-Z]:[\\/]/.test(snapshot.repoRoot) ||
      snapshot.repoRoot.startsWith('\\\\');
    const pathApi = windowsPaths ? path.win32 : path.posix;
    const relativePath = pathApi.relative(pathApi.resolve(snapshot.repoRoot), pathApi.resolve(resolvedPath));
    if (
      relativePath.length === 0 ||
      pathApi.isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${pathApi.sep}`)
    ) {
      return;
    }

    try {
      if (payload.status !== 'D') {
        try {
          const stats = await fs.promises.stat(resolvedPath);
          if (stats.isFile()) {
            await vscode.window.showTextDocument(vscode.Uri.file(resolvedPath));
            return;
          }
        } catch {
          // Missing or unreadable working-tree files are opened from the commit revision below.
        }
      }
      const revision = payload.status === 'D' ? `${payload.hash}~1` : payload.hash;
      await vscode.window.showTextDocument(
        buildShowUri(snapshot.repoRoot, `${revision}:${payload.filePath}`, payload.filePath),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open file: ${describeError(err)}`);
    }
  }

  private async resolveRemoteHost(repoRoot: string, remoteName?: string): Promise<ParsedRemoteHost | null> {
    try {
      const rawUrl = await this.gitService.getRemoteUrl(repoRoot, remoteName);
      return rawUrl === null ? null : parseRemoteHostInfo(rawUrl);
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not read remote URL: ${describeError(err)}`);
      return null;
    }
  }

  private async openHttpsUrl(url: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.reportUntrustedWorkspace();
      return;
    }
    if (!/^https:\/\/[^/]+(?:\/|$)/i.test(url)) {
      void vscode.window.showWarningMessage('Refusing to open an external URL that is not a normalized HTTPS URL.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  private async handleOpenRepoInBrowser(): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!this.ensureTrustedWorkspace() || !snapshot) {
      return;
    }
    const remote = await this.resolveRemoteHost(snapshot.repoRoot);
    if (!remote) {
      void vscode.window.showInformationMessage('This repository has no supported remote web URL.');
      return;
    }
    await this.openHttpsUrl(buildRemoteRepoUrl(remote));
  }

  private async handleOpenBranchInBrowser(targetRef?: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!this.ensureTrustedWorkspace() || !snapshot || targetRef === undefined) {
      return;
    }
    const target = this.resolveRef(targetRef, ['local', 'remote']);
    if (!target?.branch) {
      return;
    }
    let remoteName: string;
    let remoteBranch: string;
    if (target.branch.isRemote) {
      remoteName = target.branch.remoteName ?? '';
      remoteBranch = target.branch.displayName;
    } else {
      const upstream = target.branch.upstream
        ? parseUpstreamRef(
            target.branch.upstream,
            this.getRemoteNames(snapshot),
          )
        : null;
      if (!upstream || target.branch.upstreamGone) {
        void vscode.window.showInformationMessage(`Branch "${target.branch.name}" is not pushed to a remote.`);
        return;
      }
      remoteName = upstream.remoteName;
      remoteBranch = upstream.remoteBranch;
    }
    const remote = await this.resolveRemoteHost(snapshot.repoRoot, remoteName);
    const url = remote === null ? null : buildRemoteBranchUrl(remote, remoteBranch);
    if (!url) {
      void vscode.window.showInformationMessage(`The "${remoteName}" remote cannot open branches in a browser.`);
      return;
    }
    await this.openHttpsUrl(url);
  }

  private async handleOpenCommitInBrowser(hash?: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!this.ensureTrustedWorkspace() || !snapshot || !hash || !isValidCommitHash(hash)) {
      return;
    }
    const remote = await this.resolveRemoteHost(snapshot.repoRoot);
    const url = remote === null ? null : buildRemoteCommitUrl(remote, hash);
    if (!url) {
      void vscode.window.showInformationMessage('This repository has no supported remote web URL for commits.');
      return;
    }
    await this.openHttpsUrl(url);
  }

  private async handleCreatePrInBrowser(targetRef?: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!this.ensureTrustedWorkspace() || !snapshot) {
      return;
    }
    const refName = targetRef ?? snapshot.currentBranch;
    const target = this.resolveRef(refName, ['local', 'remote']);
    let remoteName: string;
    let remoteBranch: string;
    if (target?.branch?.isRemote) {
      remoteName = target.branch.remoteName ?? '';
      remoteBranch = target.branch.displayName;
    } else {
      const branch = target?.branch?.isRemote === false
        ? target.branch
        : snapshot.localBranches.find((candidate) => candidate.isCurrent);
      const upstream = branch?.upstream
        ? parseUpstreamRef(
            branch.upstream,
            this.getRemoteNames(snapshot),
          )
        : null;
      if (!branch || !upstream || branch.upstreamGone) {
        void vscode.window.showInformationMessage('Push this branch to a remote before creating a pull request.');
        return;
      }
      remoteName = upstream.remoteName;
      remoteBranch = upstream.remoteBranch;
    }
    const remoteGroup = snapshot.remoteGroups.find((group) => group.remoteName === remoteName);
    if (remoteGroup?.defaultBranch === remoteBranch) {
      void vscode.window.showInformationMessage(
        `Cannot create a pull request from the default branch (${remoteBranch}).`,
      );
      return;
    }
    const remote = await this.resolveRemoteHost(snapshot.repoRoot, remoteName);
    const url = remote === null ? null : buildRemoteCreatePrUrl(remote, remoteBranch);
    if (!url) {
      void vscode.window.showInformationMessage(`The "${remoteName}" remote cannot create pull requests in a browser.`);
      return;
    }
    await this.openHttpsUrl(url);
  }

  public async openCommitOnGitHubByHash(hash: string): Promise<boolean> {
    const normalizedHash = hash.toLowerCase();
    if (!isValidCommitHash(normalizedHash) || !vscode.workspace.isTrusted) {
      return false;
    }
    const url = this.integrations.githubRemoteUrl;
    return url !== null && this.githubService.openCommit(url, normalizedHash);
  }

  private async openCommitOnGitHub(hash: string): Promise<void> {
    if (!(await this.openCommitOnGitHubByHash(hash))) {
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
    let remoteWebUrl: string | null = null;
    let remoteProvider: ExternalIntegrationsInfo['remoteProvider'] = null;
    let remoteProviderName: string | null = null;
    if (repoRoot) {
      try {
        const rawUrl = await this.gitService.getRemoteUrl(repoRoot);
        const parsed = rawUrl === null ? null : parseRemoteHostInfo(rawUrl);
        if (parsed) {
          remoteWebUrl = parsed.webBaseUrl;
          remoteProvider = parsed.provider;
          remoteProviderName = parsed.displayName;
        }
        if (parsed?.provider === 'github') {
          githubRemoteUrl = parsed.webBaseUrl;
        }
      } catch {
        // Continue with the legacy GitHub lookup below.
      }
      try {
        const legacyGithubUrl = await this.gitService.getGitHubRemoteUrl(repoRoot);
        githubRemoteUrl = legacyGithubUrl ?? githubRemoteUrl;
      } catch {
        // Keep a GitHub result from the multi-provider resolver when available.
      }
    }
    if (
      repoRoot === undefined ||
      this.lastSnapshot === null ||
      canonicalizeRepoPath(repoRoot) !== canonicalizeRepoPath(this.lastSnapshot.repoRoot)
    ) {
      return;
    }
    const gitGraphExtensionId = findGitGraphExtensionId();
    this.integrations = {
      gitGraphAvailable: gitGraphExtensionId !== null,
      gitGraphExtensionId,
      githubRemoteUrl,
      remoteWebUrl: remoteWebUrl ?? githubRemoteUrl,
      remoteProvider: remoteProvider ?? (githubRemoteUrl ? 'github' : null),
      remoteProviderName: remoteProviderName ?? (githubRemoteUrl ? 'GitHub' : null),
    };
    this.githubRemoteByRepo.set(normalizeRepoRootPath(repoRoot ?? ''), githubRemoteUrl ?? undefined);
    this.broadcast({ type: 'integrationsInfo', payload: this.integrations });
  }

  private async copyCommitHash(hash: string): Promise<void> {
    await vscode.env.clipboard.writeText(hash);
    vscode.window.setStatusBarMessage(`Copied commit ${hash.slice(0, 8)} to the clipboard.`, 3000);
  }

  private async loadRepository(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const sequence = ++this.loadSequence;
    const initState = this.getInitState();
    this.broadcast({ type: 'initState', payload: initState });

    if (!this.ensureTrustedWorkspace()) {
      return;
    }

    const workspaceFolderPaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    const configuredWorkspaceRoot = vscode.workspace
      .getConfiguration('gitRepoAndBranchExplorer')
      .get<string>('workspaceRoot', '')
      .trim();
    this.discoveredRepos = await discoverWorkspaceRepositories(workspaceFolderPaths, configuredWorkspaceRoot);
    if (sequence !== this.loadSequence || this.disposed) {
      return;
    }
    const selected = this.selectedRepoRoot === null
      ? undefined
      : this.discoveredRepos.find(
          (repo) => canonicalizeRepoPath(repo.repoRoot) === canonicalizeRepoPath(this.selectedRepoRoot!),
        );
    const activeRepoRoot = selected?.repoRoot ?? this.discoveredRepos[0]?.repoRoot ?? initState.workspacePath;
    if (activeRepoRoot === null) {
      this.lastSnapshot = null;
      this.selectedRepoRoot = null;
      this.gitDiffProvider?.clearAllowedRepoRoots();
      this.updateGitWatcher(null);
      this.host.onCurrentBranchChange(null);
      this.broadcast({ type: 'workspaceRepos', payload: { repos: this.discoveredRepos, activeRepoRoot: null } });
      this.broadcast({
        type: 'repoError',
        payload: { code: 'NO_WORKSPACE', message: 'Open a folder that contains a Git repository.' },
      });
      this.notifyRepositoryChange(null);
      return;
    }

    try {
      const rawSnapshot = await this.gitService.getRepoSnapshot(activeRepoRoot);
      // Drop results superseded by a newer refresh or disposed by extension shutdown.
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      const snapshotRepo = this.discoveredRepos.find(
        (repo) =>
          canonicalizeRepoPath(repo.repoRoot) === canonicalizeRepoPath(rawSnapshot.repoRoot) ||
          canonicalizeRepoPath(repo.repoRoot) === canonicalizeRepoPath(activeRepoRoot),
      );
      const snapshot = {
        ...rawSnapshot,
        repoRoot: snapshotRepo?.repoRoot ?? canonicalizeRepoPath(rawSnapshot.repoRoot),
      };
      this.lastSnapshot = snapshot;
      this.selectedRepoRoot = snapshot.repoRoot;
      this.gitDiffProvider?.setAllowedRepoRoots(new Set([
        ...this.discoveredRepos.map((repo) => repo.repoRoot),
        snapshot.repoRoot,
        ...snapshot.worktrees?.map((worktree) => worktree.path) ?? [],
      ]));
      // Each webview reconciles its own selection with the snapshot identically, so no extra sync message is needed.
      this.selection = normalizeSelection(snapshot, this.selection);
      this.updateGitWatcher(snapshot.repoRoot);
      this.host.onCurrentBranchChange(snapshot.currentBranch);
      this.broadcast({
        type: 'workspaceRepos',
        payload: { repos: this.discoveredRepos, activeRepoRoot: snapshot.repoRoot },
      });
      this.broadcast({ type: 'repoSnapshot', payload: snapshot });
      this.flushPendingRevealCommit();
      this.flushPendingCreateBranchDialog();
      this.flushPendingCreateWorktreeDialog();
      await this.publishIntegrations();
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      this.notifyRepositoryChange(snapshot.repoRoot);
    } catch (err) {
      if (sequence !== this.loadSequence || this.disposed) {
        return;
      }
      this.lastSnapshot = null;
      this.selectedRepoRoot = null;
      this.gitDiffProvider?.clearAllowedRepoRoots();
      this.updateGitWatcher(null);
      this.host.onCurrentBranchChange(null);
      this.broadcast({ type: 'workspaceRepos', payload: { repos: this.discoveredRepos, activeRepoRoot: null } });
      this.broadcast({ type: 'repoError', payload: toRepoErrorPayload(err) });
      this.notifyRepositoryChange(null);
    }
  }

  /** (Re)creates the `.git` watcher only when the repository root actually changes. */
  private updateGitWatcher(repoRoot: string | null): void {
    if (
      (repoRoot === null && this.watchedRepoRoot === null) ||
      (repoRoot !== null &&
        this.watchedRepoRoot !== null &&
        canonicalizeRepoPath(repoRoot) === canonicalizeRepoPath(this.watchedRepoRoot))
    ) {
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
    this.discoveredRepos = [];
    this.selectedRepoRoot = null;
    this.githubRemoteByRepo.clear();
    this.selection = EMPTY_SELECTION;
    this.gitDiffProvider?.clearAllowedRepoRoots();
    this.updateGitWatcher(null);
    this.host.onCurrentBranchChange(null);
    this.broadcast({ type: 'workspaceRepos', payload: { repos: [], activeRepoRoot: null } });
    this.broadcast({
      type: 'repoError',
      payload: { code: 'UNTRUSTED_WORKSPACE', message: WORKSPACE_TRUST_ERROR_MESSAGE },
    });
    this.notifyRepositoryChange(null);
  }

  private async loadNextCommitPage(): Promise<boolean> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || !snapshot.hasMoreCommits) {
      return false;
    }
    if (this.isLoadingMoreCommits) {
      return this.loadingMoreCommits ?? false;
    }
    this.isLoadingMoreCommits = true;
    const loading = (async (): Promise<boolean> => {
      const page = await this.gitService.getCommitPage(snapshot.repoRoot, snapshot.commits.length);
      if (
        this.lastSnapshot === null ||
        snapshot !== this.lastSnapshot ||
        canonicalizeRepoPath(snapshot.repoRoot) !== canonicalizeRepoPath(this.lastSnapshot.repoRoot)
      ) {
        return false;
      }
      const knownHashes = new Set(snapshot.commits.map((commit) => commit.hash));
      const appended = page.commits.filter((commit) => {
        if (knownHashes.has(commit.hash)) {
          return false;
        }
        knownHashes.add(commit.hash);
        return true;
      });
      snapshot.commits.push(...appended);
      snapshot.hasMoreCommits = page.hasMoreCommits;
      this.broadcast({
        type: 'commitsAppended',
        payload: { commits: appended, hasMoreCommits: snapshot.hasMoreCommits },
      });
      return appended.length > 0;
    })();
    this.loadingMoreCommits = loading;
    try {
      return await loading;
    } finally {
      this.isLoadingMoreCommits = false;
      this.loadingMoreCommits = null;
    }
  }

  private async flushPendingRevealCommit(): Promise<void> {
    const hash = this.pendingRevealCommitHash;
    const panel = this.surfaces.get('editor');
    if (
      hash === null ||
      panel === undefined ||
      this.lastSnapshot === null ||
      !this.readySurfaces.has('editor') ||
      this.isSearchingForRevealCommit
    ) {
      return;
    }

    this.isSearchingForRevealCommit = true;
    try {
      if (this.lastSnapshot.commits.some((commit) => commit.hash === hash)) {
        panel.post({ type: 'revealCommit', payload: { hash } });
        return;
      }

      for (let page = 0; page < MAX_REVEAL_SEARCH_PAGES && this.lastSnapshot.hasMoreCommits; page++) {
        this.postActionStatus(true, `Searching older commits for ${hash.slice(0, 8)}...`);
        try {
          await this.loadNextCommitPage();
        } catch {
          break;
        }
        if (this.lastSnapshot.commits.some((commit) => commit.hash === hash)) {
          this.postActionStatus(false);
          panel.post({ type: 'revealCommit', payload: { hash } });
          return;
        }
      }

      try {
        const details = await this.gitService.getCommitDetails(this.lastSnapshot.repoRoot, hash);
        panel.post({ type: 'commitDetails', payload: details });
        this.postActionStatus(false);
        panel.post({ type: 'revealCommit', payload: { hash, outsideGraph: true } });
      } catch (err) {
        this.postActionStatus(false);
        void vscode.window.showWarningMessage(
          `Could not find commit ${hash.slice(0, 8)} in this repository: ${describeError(err)}`,
        );
      }
    } finally {
      this.isSearchingForRevealCommit = false;
      if (this.pendingRevealCommitHash === hash) {
        this.pendingRevealCommitHash = null;
      }
      if (this.pendingRevealCommitHash !== null) {
        void this.flushPendingRevealCommit();
      }
    }
  }

  private flushPendingCreateBranchDialog(): void {
    const request = this.pendingCreateBranchDialog;
    const editor = this.surfaces.get('editor');
    if (request === null || !editor || !this.readySurfaces.has('editor')) {
      return;
    }
    editor.post({ type: 'showCreateBranchDialog', payload: request });
    if (this.pendingCreateBranchDialog === request) {
      this.pendingCreateBranchDialog = null;
    }
  }

  private flushPendingCreateWorktreeDialog(): void {
    const request = this.pendingCreateWorktreeDialog;
    const editor = this.surfaces.get('editor');
    if (
      request === null ||
      editor === undefined ||
      !this.readySurfaces.has('editor') ||
      this.lastSnapshot === null
    ) {
      return;
    }
    editor.post({ type: 'showCreateWorktreeDialog', payload: request });
    if (this.pendingCreateWorktreeDialog === request) {
      this.pendingCreateWorktreeDialog = null;
    }
  }

  private notifyRepositoryChange(repoRoot: string | null): void {
    for (const listener of this.repositoryChangeListeners) {
      listener(repoRoot);
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
    this.repositoryChangeListeners.clear();
    this.surfaces.clear();
    this.readySurfaces.clear();
    this.gitDiffProvider?.clearAllowedRepoRoots();
    this.disposeGitWatcher();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
