import type {
  ChangedFileStatus,
  CommitDetails,
  CommitNode,
  ExternalIntegrationsInfo,
  RepoSnapshot,
  WorkspaceRepoInfo,
} from './git';
import type { CreateBranchDialogRequest, CreateBranchSourceKind } from '../webview/ui/branchCreateModel';

export type TrackingIndicatorOrder = 'vscode' | 'visualStudio';

export type GitAction =
  | 'fetch'
  | 'fetchTracked'
  | 'pull'
  | 'push'
  | 'pushAndOpenPr'
  | 'openRepoInBrowser'
  | 'openBranchInBrowser'
  | 'openCommitInBrowser'
  | 'createPrInBrowser'
  | 'createBranch'
  | 'renameBranch'
  | 'untrackBranch'
  | 'publishRepository'
  | 'merge'
  | 'rebase'
  | 'cherryPick'
  | 'revert'
  | 'revertMerge'
  | 'deleteBranch'
  | 'checkoutRemoteBranch'
  | 'resetMixed'
  | 'resetHard';

export const GIT_ACTION_LABELS: Readonly<Record<GitAction, string>> = {
  fetch: 'Fetch',
  fetchTracked: 'Fetch Tracked Branches',
  pull: 'Pull',
  push: 'Push',
  pushAndOpenPr: 'Push and Open PR in Browser',
  openRepoInBrowser: 'Open Repository in Browser',
  openBranchInBrowser: 'Open Branch in Browser',
  openCommitInBrowser: 'Open Commit in Browser',
  createPrInBrowser: 'Create Pull Request in Browser',
  createBranch: 'New Branch',
  renameBranch: 'Rename Branch',
  untrackBranch: 'Untrack Remote Branch',
  publishRepository: 'Publish Repository / Add Remote',
  merge: 'Merge',
  rebase: 'Rebase',
  cherryPick: 'Cherry-Pick',
  revert: 'Revert',
  revertMerge: 'Revert Merge Commit',
  deleteBranch: 'Delete Branch',
  checkoutRemoteBranch: 'Check Out as Local Branch',
  resetMixed: 'Reset (Keep Changes)',
  resetHard: 'Reset (Delete Changes)',
};

/** What a `gitAction` must carry in `target`: nothing, a ref name (branch/tag), or a full commit hash. */
export type GitActionTargetKind = 'none' | 'optionalRef' | 'ref' | 'commit' | 'refOrCommit';

export const GIT_ACTION_TARGETS: Readonly<Record<GitAction, GitActionTargetKind>> = {
  fetch: 'none',
  fetchTracked: 'none',
  pull: 'none',
  push: 'optionalRef',
  pushAndOpenPr: 'optionalRef',
  openRepoInBrowser: 'none',
  openBranchInBrowser: 'ref',
  openCommitInBrowser: 'commit',
  createPrInBrowser: 'optionalRef',
  createBranch: 'none',
  renameBranch: 'ref',
  untrackBranch: 'ref',
  publishRepository: 'none',
  merge: 'ref',
  rebase: 'ref',
  cherryPick: 'commit',
  revert: 'commit',
  revertMerge: 'commit',
  deleteBranch: 'ref',
  checkoutRemoteBranch: 'ref',
  resetMixed: 'refOrCommit',
  resetHard: 'refOrCommit',
};

export interface GitActionPayload {
  action: GitAction;
  target?: string;
}

/**
 * Ref selection shared by the Activity Bar branch tree and the editor timeline. Everything else the two
 * views display (current branch, local/remote branches, tags) travels inside `repoSnapshot`.
 */
export interface SyncStatePayload {
  /** Inspected branch/tag (full ref name); its history is focused. `null` when nothing is selected. */
  selectedBranchFullName: string | null;
  /** Git-usable short name of the selected ref; `null` exactly when `selectedBranchFullName` is. */
  selectedBranchRef: string | null;
  /** Branches isolated in the history, as full ref names. */
  pinnedBranchFullNames: string[];
}

export const MAX_SYNC_PINNED_REFS = 2000;

export type WebviewToExtensionMessage =
  | { type: 'webviewReady' }
  | { type: 'openRepositoryPanel' }
  | { type: 'requestRefresh' }
  | { type: 'selectRepository'; payload: { repoRoot: string } }
  | { type: 'loadMoreCommits' }
  | { type: 'syncState'; payload: SyncStatePayload }
  | { type: 'checkoutBranch'; payload: { branchName: string } }
  | { type: 'gitAction'; payload: GitActionPayload }
  | { type: 'createBranchAtRef'; payload: { startPoint: string } }
  | { type: 'openCreateBranchDialog'; payload: { startPoint?: string; sourceKind?: CreateBranchSourceKind } }
  | { type: 'submitCreateBranch'; payload: { branchName: string; startPoint?: string; checkout: boolean; track: boolean } }
  | { type: 'setTabPinned'; payload: { pinned: boolean } }
  | { type: 'setShowCheckedOutBadge'; payload: { show: boolean } }
  | { type: 'setShowFolderCounts'; payload: { show: boolean } }
  | { type: 'setTrackingOrder'; payload: { order: TrackingIndicatorOrder } }
  | { type: 'copyCommitHash'; payload: { hash: string } }
  | { type: 'requestCommitDetails'; payload: { hash: string } }
  | { type: 'openFile'; payload: { hash: string; filePath: string; status: string } }
  | { type: 'openFileDiff'; payload: OpenFileDiffPayload }
  | { type: 'openInGitGraph' }
  | { type: 'openCommitOnGitHub'; payload: { hash: string } }
  | { type: 'signInGitHub' };

export interface OpenFileDiffPayload {
  hash: string;
  filePath: string;
  oldPath?: string;
  status: string;
}

const MAX_BRANCH_NAME_LENGTH = 255;
/** Full SHA-1 (40 hex) or SHA-256 (64 hex); must stay identical to `isValidCommitHash` in gitService.ts. */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
export const MAX_FILE_PATH_LENGTH = 4096;
export const MAX_ACTION_STATUS_LENGTH = 500;

export const CHANGED_FILE_STATUSES: readonly ChangedFileStatus[] = ['A', 'M', 'D', 'R', 'C', 'T', 'U'];

export function isChangedFileStatus(value: unknown): value is ChangedFileStatus {
  return typeof value === 'string' && (CHANGED_FILE_STATUSES as readonly string[]).includes(value);
}

/**
 * True for a repository-relative path that cannot escape the repository: non-empty, bounded,
 * no control characters, not absolute (POSIX, UNC or drive-letter) and no `.`/`..` segments.
 */
export function isSafeRepoRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_PATH_LENGTH) {
    return false;
  }
  if (/[\x00-\x1f\x7f]/.test(value) || /^[\\/]/.test(value) || /^[a-zA-Z]:/.test(value)) {
    return false;
  }
  return value.split(/[\\/]/).every((segment) => segment !== '..' && segment !== '.' && segment !== '');
}

export interface InitStatePayload {
  repoName: string;
  workspacePath: string | null;
  /** Whether the editor tab is pinned (kept open when another sidebar view is selected). */
  tabPinned?: boolean;
  /** Whether the sidebar shows the "Checked Out" pill next to the checked-out branch (default `true`). */
  showCheckedOutBadge: boolean;
  /** Whether branch-folder rows show their contained branch counts (default `true`). */
  showFolderCounts: boolean;
  /** Display incoming before outgoing counters like VS Code, or Visual Studio's outgoing-first order. */
  trackingOrder?: TrackingIndicatorOrder;
}

export interface RepoErrorPayload {
  message: string;
  code?: string;
}

export type ExtensionToWebviewMessage =
  | { type: 'initState'; payload: InitStatePayload }
  | { type: 'repoSnapshot'; payload: RepoSnapshot }
  | { type: 'workspaceRepos'; payload: { repos: WorkspaceRepoInfo[]; activeRepoRoot: string | null } }
  | { type: 'commitsAppended'; payload: { commits: CommitNode[]; hasMoreCommits: boolean } }
  | { type: 'repoError'; payload: RepoErrorPayload }
  | { type: 'commitDetails'; payload: CommitDetails }
  | { type: 'integrationsInfo'; payload: ExternalIntegrationsInfo }
  | { type: 'actionStatus'; payload: ActionStatusPayload }
  | { type: 'syncState'; payload: SyncStatePayload }
  | { type: 'revealCommit'; payload: { hash: string; outsideGraph?: boolean } }
  | { type: 'showCreateBranchDialog'; payload: CreateBranchDialogRequest };

export interface ActionStatusPayload {
  busy: boolean;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/** A plain data record whose fields are own properties and which carries no prototype-pollution keys. */
function isSafeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    FORBIDDEN_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(value, key))
  );
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function hasOnlyFields(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isGitAction(value: unknown): value is GitAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GIT_ACTION_LABELS, value);
}

function isTrackingIndicatorOrder(value: unknown): value is TrackingIndicatorOrder {
  return value === 'vscode' || value === 'visualStudio';
}

function isCreateBranchSourceKind(value: unknown): value is CreateBranchSourceKind {
  return value === 'remote' || value === 'local' || value === 'tag' || value === 'commit' || value === 'head';
}

/**
 * Cheap syntactic screen for a ref name received from a webview (bounded, no control characters or
 * whitespace, no option-like leading `-`). The extension still runs `validateGitRef` and matches the
 * name against the loaded snapshot before any Git command runs.
 */
export function isSafeRefArgument(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BRANCH_NAME_LENGTH &&
    !value.startsWith('-') &&
    !/[\x00-\x20\x7f]/.test(value)
  );
}

/** Shape check for a selection payload; whether the refs exist is decided against the loaded snapshot. */
export function isSyncStatePayload(value: unknown): value is SyncStatePayload {
  if (!isSafeRecord(value)) {
    return false;
  }
  const fullName = ownField(value, 'selectedBranchFullName');
  const ref = ownField(value, 'selectedBranchRef');
  const pinned = ownField(value, 'pinnedBranchFullNames');
  const selectionIsNull = fullName === null && ref === null;
  const selectionIsSafe = isSafeRefArgument(fullName) && isSafeRefArgument(ref);
  return (
    (selectionIsNull || selectionIsSafe) &&
    Array.isArray(pinned) &&
    pinned.length <= MAX_SYNC_PINNED_REFS &&
    pinned.every((name: unknown) => isSafeRefArgument(name))
  );
}

function isValidGitActionPayload(payload: Record<string, unknown> | null): boolean {
  if (payload === null || !hasOnlyFields(payload, ['action', 'target'])) {
    return false;
  }
  const action = ownField(payload, 'action');
  if (!isGitAction(action)) {
    return false;
  }
  const target = ownField(payload, 'target');
  switch (GIT_ACTION_TARGETS[action]) {
    case 'none':
      return target === undefined;
    case 'optionalRef':
      return target === undefined || isSafeRefArgument(target);
    case 'ref':
      return isSafeRefArgument(target);
    case 'commit':
      return isCommitHash(target);
    case 'refOrCommit':
      return isCommitHash(target) || isSafeRefArgument(target);
  }
}

/** Validates untrusted data received from a webview before the extension acts on it. */
export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isSafeRecord(value)) {
    return false;
  }
  const rawPayload = ownField(value, 'payload');
  const payload = rawPayload === undefined ? null : isSafeRecord(rawPayload) ? rawPayload : undefined;
  if (payload === undefined) {
    return false;
  }
  switch (ownField(value, 'type')) {
    case 'webviewReady':
    case 'openRepositoryPanel':
    case 'requestRefresh':
    case 'loadMoreCommits':
      return true;
    case 'checkoutBranch': {
      const branchName = payload === null ? undefined : ownField(payload, 'branchName');
      return isSafeRefArgument(branchName);
    }
    case 'selectRepository': {
      if (payload === null || !hasOnlyFields(payload, ['repoRoot'])) {
        return false;
      }
      const repoRoot = ownField(payload, 'repoRoot');
      return typeof repoRoot === 'string' && repoRoot.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(repoRoot);
    }
    case 'syncState':
      return isSyncStatePayload(payload);
    case 'gitAction':
      return isValidGitActionPayload(payload);
    case 'createBranchAtRef': {
      const startPoint = payload === null ? undefined : ownField(payload, 'startPoint');
      return isCommitHash(startPoint) || isSafeRefArgument(startPoint);
    }
    case 'openCreateBranchDialog':
      if (payload === null) {
        return false;
      }
      {
        const startPoint = ownField(payload, 'startPoint');
        const sourceKind = ownField(payload, 'sourceKind');
        return (
          hasOnlyFields(payload, ['startPoint', 'sourceKind']) &&
          (startPoint === undefined || isCommitHash(startPoint) || isSafeRefArgument(startPoint)) &&
          (sourceKind === undefined || isCreateBranchSourceKind(sourceKind))
        );
      }
    case 'submitCreateBranch':
      if (payload === null) {
        return false;
      }
      {
        const branchName = ownField(payload, 'branchName');
        const startPoint = ownField(payload, 'startPoint');
        return (
          hasOnlyFields(payload, ['branchName', 'startPoint', 'checkout', 'track']) &&
          isSafeRefArgument(branchName) &&
          (startPoint === undefined || isCommitHash(startPoint) || isSafeRefArgument(startPoint)) &&
          typeof ownField(payload, 'checkout') === 'boolean' &&
          typeof ownField(payload, 'track') === 'boolean'
        );
      }
    case 'setTabPinned':
      return payload !== null && typeof ownField(payload, 'pinned') === 'boolean';
    case 'setShowCheckedOutBadge':
    case 'setShowFolderCounts':
      return payload !== null && typeof ownField(payload, 'show') === 'boolean';
    case 'setTrackingOrder':
      return payload !== null && isTrackingIndicatorOrder(ownField(payload, 'order'));
    case 'copyCommitHash':
    case 'requestCommitDetails':
    case 'openCommitOnGitHub':
      return payload !== null && isCommitHash(ownField(payload, 'hash'));
    case 'openFile':
    case 'openFileDiff':
      return payload !== null && isOpenFileDiffPayload(payload);
    case 'openInGitGraph':
    case 'signInGitHub':
      return true;
    default:
      return false;
  }
}

function isCommitHash(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_HASH_PATTERN.test(value);
}

function isCommitNodeShape(value: unknown): value is CommitNode {
  if (!isSafeRecord(value)) {
    return false;
  }
  return (
    isCommitHash(ownField(value, 'hash')) &&
    typeof ownField(value, 'shortHash') === 'string' &&
    Array.isArray(ownField(value, 'parents')) &&
    (ownField(value, 'parents') as unknown[]).every(isCommitHash) &&
    typeof ownField(value, 'subject') === 'string' &&
    typeof ownField(value, 'authorName') === 'string' &&
    typeof ownField(value, 'authorEmail') === 'string' &&
    typeof ownField(value, 'authorDateIso') === 'string' &&
    typeof ownField(value, 'authorTimestamp') === 'number' &&
    Array.isArray(ownField(value, 'refs')) &&
    (ownField(value, 'refs') as unknown[]).every(
      (ref: unknown) =>
        isSafeRecord(ref) &&
        ['head', 'localBranch', 'remoteBranch', 'tag'].includes(String(ownField(ref, 'kind'))) &&
        typeof ownField(ref, 'label') === 'string',
    )
  );
}

function isOpenFileDiffPayload(payload: Record<string, unknown>): boolean {
  const status = ownField(payload, 'status');
  const oldPath = ownField(payload, 'oldPath');
  return (
    isCommitHash(ownField(payload, 'hash')) &&
    isSafeRepoRelativePath(ownField(payload, 'filePath')) &&
    isChangedFileStatus(status) &&
    (oldPath === undefined || isSafeRepoRelativePath(oldPath))
  );
}

export const isValidWebviewMessage = isWebviewToExtensionMessage;

function isRepoSnapshotShape(p: Record<string, unknown>): boolean {
  return (
    typeof p.repoName === 'string' &&
    typeof p.repoRoot === 'string' &&
    typeof p.currentBranch === 'string' &&
    typeof p.isDetachedHead === 'boolean' &&
    Array.isArray(p.localBranches) &&
    (p.remotes === undefined || (Array.isArray(p.remotes) && p.remotes.every((name: unknown) => isSafeRefArgument(name)))) &&
    Array.isArray(p.remoteGroups) &&
    Array.isArray(p.tags) &&
    Array.isArray(p.commits) &&
    typeof p.hasMoreCommits === 'boolean'
  );
}

export function isExtensionToWebviewMessage(value: unknown): value is ExtensionToWebviewMessage {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return false;
  }
  const payload = value.payload;
  switch (value.type) {
    case 'initState':
      return (
        typeof payload.repoName === 'string' &&
        (payload.workspacePath === null || typeof payload.workspacePath === 'string') &&
        (payload.tabPinned === undefined || typeof payload.tabPinned === 'boolean') &&
        (payload.showCheckedOutBadge === undefined || typeof payload.showCheckedOutBadge === 'boolean') &&
        (payload.showFolderCounts === undefined || typeof payload.showFolderCounts === 'boolean') &&
        (payload.trackingOrder === undefined || isTrackingIndicatorOrder(payload.trackingOrder))
      );
    case 'repoSnapshot':
      return isRepoSnapshotShape(payload);
    case 'workspaceRepos':
      return (
        Array.isArray(payload.repos) &&
        payload.repos.every(isWorkspaceRepoInfoShape) &&
        (payload.activeRepoRoot === null || typeof payload.activeRepoRoot === 'string')
      );
    case 'commitsAppended':
      return (
        Array.isArray(payload.commits) &&
        payload.commits.every((commit: unknown) => isCommitNodeShape(commit)) &&
        typeof payload.hasMoreCommits === 'boolean'
      );
    case 'repoError':
      return typeof payload.message === 'string' && (payload.code === undefined || typeof payload.code === 'string');
    case 'commitDetails':
      return (
        typeof payload.hash === 'string' &&
        typeof payload.body === 'string' &&
        Array.isArray(payload.files) &&
        payload.files.every(
          (f: unknown) => isRecord(f) && isChangedFileStatus(f.status) && typeof f.path === 'string',
        )
      );
    case 'integrationsInfo':
      return (
        typeof payload.gitGraphAvailable === 'boolean' &&
        (payload.gitGraphExtensionId === null || typeof payload.gitGraphExtensionId === 'string') &&
        (payload.githubRemoteUrl === null || typeof payload.githubRemoteUrl === 'string') &&
        (payload.remoteWebUrl === undefined || payload.remoteWebUrl === null || typeof payload.remoteWebUrl === 'string') &&
        (payload.remoteProvider === undefined ||
          payload.remoteProvider === null ||
          ['github', 'azureDevOps', 'gitlab', 'bitbucket'].includes(String(payload.remoteProvider))) &&
        (payload.remoteProviderName === undefined ||
          payload.remoteProviderName === null ||
          typeof payload.remoteProviderName === 'string')
      );
    case 'actionStatus':
      return (
        typeof payload.busy === 'boolean' &&
        (payload.message === undefined ||
          (typeof payload.message === 'string' && payload.message.length <= MAX_ACTION_STATUS_LENGTH))
      );
    case 'syncState':
      return isSyncStatePayload(payload);
    case 'revealCommit':
      return (
        isCommitHash(payload.hash) &&
        (payload.outsideGraph === undefined || typeof payload.outsideGraph === 'boolean')
      );
    case 'showCreateBranchDialog':
      return (
        isSafeRecord(payload) &&
        hasOnlyFields(payload, [
          'sourceKind',
          'startPoint',
          'startLabel',
          'initialName',
          'remoteTrackingRef',
          'existingLocalBranches',
        ]) &&
        isCreateBranchSourceKind(payload.sourceKind) &&
        (payload.startPoint === undefined || isCommitHash(payload.startPoint) || isSafeRefArgument(payload.startPoint)) &&
        typeof payload.startLabel === 'string' &&
        typeof payload.initialName === 'string' &&
        (payload.remoteTrackingRef === undefined || isSafeRefArgument(payload.remoteTrackingRef)) &&
        Array.isArray(payload.existingLocalBranches) &&
        payload.existingLocalBranches.every((branch: unknown) => isSafeRefArgument(branch))
      );
    default:
      return false;
  }
}

function isWorkspaceRepoInfoShape(value: unknown): value is WorkspaceRepoInfo {
  return (
    isSafeRecord(value) &&
    hasOnlyFields(value, ['repoRoot', 'repoName', 'commonDir', 'currentBranch', 'isDetachedHead']) &&
    typeof ownField(value, 'repoRoot') === 'string' &&
    ownField(value, 'repoRoot') !== '' &&
    typeof ownField(value, 'repoName') === 'string' &&
    ownField(value, 'repoName') !== '' &&
    typeof ownField(value, 'commonDir') === 'string' &&
    ownField(value, 'commonDir') !== '' &&
    (ownField(value, 'currentBranch') === undefined || typeof ownField(value, 'currentBranch') === 'string') &&
    (ownField(value, 'isDetachedHead') === undefined || typeof ownField(value, 'isDetachedHead') === 'boolean')
  );
}
