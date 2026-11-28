import type {
  ChangedFileStatus,
  CommitDetails,
  CommitNode,
  ExternalIntegrationsInfo,
  FileHistoryCommit,
  FileHistoryResult,
  RepoSnapshot,
  RefComparisonResult,
  StashInfo,
  WorkspaceRepoInfo,
} from './git';
import type { CreateBranchDialogRequest, CreateBranchSourceKind } from '../webview/ui/branchCreateModel';
import type { CreateWorktreeDialogPayload } from '../webview/ui/worktreeCreateModel';

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
  | 'createTag'
  | 'renameBranch'
  | 'untrackBranch'
  | 'publishRepository'
  | 'removeRepoFromWorkspace'
  | 'merge'
  | 'rebase'
  | 'cherryPick'
  | 'cherryPickIntoWorktree'
  | 'revert'
  | 'revertMerge'
  | 'deleteBranch'
  | 'deleteTag'
  | 'pushTag'
  | 'checkoutRemoteBranch'
  | 'resetMixed'
  | 'resetHard'
  | 'compareWithCurrent'
  | 'compareWithOther'
  | 'createWorktree'
  | 'openWorktree'
  | 'removeWorktree'
  | 'copyWorktreePath'
  | 'amendCommit'
  | 'createPatch'
  | 'applyPatch';

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
  createTag: 'Create Tag',
  renameBranch: 'Rename Branch',
  untrackBranch: 'Untrack Remote Branch',
  publishRepository: 'Publish Repository / Add Remote',
  removeRepoFromWorkspace: 'Remove Folder from Workspace',
  merge: 'Merge',
  rebase: 'Rebase',
  cherryPick: 'Cherry-Pick',
  cherryPickIntoWorktree: 'Cherry-Pick into Worktree',
  revert: 'Revert',
  revertMerge: 'Revert Merge Commit',
  deleteBranch: 'Delete Branch',
  deleteTag: 'Delete Tag',
  pushTag: 'Push Tag',
  checkoutRemoteBranch: 'Check Out as Local Branch',
  resetMixed: 'Reset (Keep Changes)',
  resetHard: 'Reset (Delete Changes)',
  compareWithCurrent: 'Compare with Current Branch',
  compareWithOther: 'Compare with Another Reference',
  createWorktree: 'Create Worktree',
  openWorktree: 'Open Worktree in New Window',
  removeWorktree: 'Remove Worktree',
  copyWorktreePath: 'Copy Worktree Path',
  amendCommit: 'Amend Last Commit',
  createPatch: 'Create Patch',
  applyPatch: 'Apply Patch',
};

/** What a `gitAction` must carry in `target`: nothing, a ref/hash, a path, or a stash reflog selector. */
export type GitActionTargetKind = 'none' | 'optionalRef' | 'ref' | 'commit' | 'refOrCommit' | 'path';

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
  createTag: 'commit',
  renameBranch: 'ref',
  untrackBranch: 'ref',
  publishRepository: 'none',
  removeRepoFromWorkspace: 'path',
  merge: 'ref',
  rebase: 'ref',
  cherryPick: 'commit',
  cherryPickIntoWorktree: 'commit',
  revert: 'commit',
  revertMerge: 'commit',
  deleteBranch: 'ref',
  deleteTag: 'ref',
  pushTag: 'ref',
  checkoutRemoteBranch: 'ref',
  resetMixed: 'refOrCommit',
  resetHard: 'refOrCommit',
  compareWithCurrent: 'refOrCommit',
  compareWithOther: 'refOrCommit',
  createWorktree: 'optionalRef',
  openWorktree: 'path',
  removeWorktree: 'path',
  copyWorktreePath: 'path',
  amendCommit: 'commit',
  createPatch: 'commit',
  applyPatch: 'none',
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
  | { type: 'cloneRepository' }
  | { type: 'selectRepository'; payload: { repoRoot: string } }
  | { type: 'loadMoreCommits' }
  | { type: 'syncState'; payload: SyncStatePayload }
  | { type: 'checkoutBranch'; payload: { branchName: string } }
  | { type: 'gitAction'; payload: GitActionPayload }
  | { type: 'createBranchAtRef'; payload: { startPoint: string } }
  | { type: 'openCreateBranchDialog'; payload: { startPoint?: string; sourceKind?: CreateBranchSourceKind } }
  | { type: 'submitCreateBranch'; payload: { branchName: string; startPoint?: string; checkout: boolean; track: boolean } }
  | { type: 'stashChanges' }
  | { type: 'inspectStash'; ref: string; hash: string }
  | { type: 'applyStash'; ref: string }
  | { type: 'popStash'; ref: string }
  | { type: 'dropStash'; ref: string }
  | { type: 'browseWorktreeParentFolder'; payload: { currentParentPath?: string } }
  | {
      type: 'submitCreateWorktree';
      payload: {
        branchName: string;
        createBranch: boolean;
        startPoint?: string;
        parentFolderPath: string;
        folderName: string;
        openInNewWindow: boolean;
      };
    }
  | { type: 'setTabPinned'; payload: { pinned: boolean } }
  | { type: 'setShowCheckedOutBadge'; payload: { show: boolean } }
  | { type: 'setShowFolderCounts'; payload: { show: boolean } }
  | { type: 'setTrackingOrder'; payload: { order: TrackingIndicatorOrder } }
  | { type: 'copyCommitHash'; payload: { hash: string } }
  | { type: 'requestCommitDetails'; payload: { hash: string } }
  | { type: 'searchCommitsByFile'; payload: { query: string; requestId: number } }
  | { type: 'openFile'; payload: { hash: string; filePath: string; status: string } }
  | { type: 'openFileDiff'; payload: OpenFileDiffPayload }
  | { type: 'openInGitGraph' }
  | { type: 'openCommitOnGitHub'; payload: { hash: string } }
  | { type: 'closeFileHistory' }
  | { type: 'closeRefComparison' }
  | { type: 'swapRefComparison' }
  | { type: 'openCompareFileDiff'; payload: { filePath: string; oldPath?: string; status: ChangedFileStatus } }
  | { type: 'loadMoreFileHistory' }
  | {
      type: 'compareFileRevisions';
      payload: { olderHash: string; olderPath: string; newerHash: string; newerPath: string };
    }
  | {
      type: 'compareRevisionWithWorkingTree';
      payload: { hash: string; filePathAtCommit: string; currentFilePath: string };
    }
  | { type: 'openFileAtRevision'; payload: { hash: string; filePathAtCommit: string } }
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
  | { type: 'fileHistoryLoaded'; payload: FileHistoryResult }
  | {
      type: 'fileHistoryAppended';
      payload: { filePath: string; commits: FileHistoryCommit[]; hasMore: boolean };
    }
  | { type: 'clearFileHistory' }
  | { type: 'refComparisonLoaded'; payload: RefComparisonResult }
  | { type: 'clearRefComparison' }
  | { type: 'fileSearchResults'; payload: { query: string; requestId: number; matchingHashes: string[] } }
  | { type: 'integrationsInfo'; payload: ExternalIntegrationsInfo }
  | { type: 'actionStatus'; payload: ActionStatusPayload }
  | { type: 'syncState'; payload: SyncStatePayload }
  | { type: 'revealCommit'; payload: { hash: string; outsideGraph?: boolean } }
  | { type: 'showCreateBranchDialog'; payload: CreateBranchDialogRequest }
  | { type: 'showCreateWorktreeDialog'; payload: CreateWorktreeDialogPayload }
  | {
      type: 'worktreeParentFolderSelected';
      payload: { parentFolderPath: string; existingChildNames: string[] };
    };

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

function isSafeStrictRefArgument(value: unknown): value is string {
  if (!isSafeRefArgument(value)) {
    return false;
  }
  return !(
    ['..', '@{', '~', '^', ':', '?', '*', '[', '\\'].some((sequence) => value.includes(sequence)) ||
    value === '@' ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('//') ||
    value.includes('/.')
  );
}

function isSafeFileSearchQuery(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    return false;
  }
  let normalized = value.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./') || normalized.startsWith('/')) {
    normalized = normalized.startsWith('./') ? normalized.slice(2) : normalized.slice(1);
  }
  return (
    normalized.length > 0 &&
    !normalized.startsWith('-') &&
    !normalized.split('/').includes('..') &&
    !normalized.includes(':(')
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
      return action === 'deleteTag' || action === 'pushTag'
        ? isSafeStrictRefArgument(target)
        : isSafeRefArgument(target);
    case 'commit':
      return isCommitHash(target);
    case 'refOrCommit':
      return isCommitHash(target) || isSafeRefArgument(target);
    case 'path':
      return isSafePathArgument(target);
  }
}

export function isSafeStashRefArgument(value: unknown): value is string {
  return typeof value === 'string' && /^stash@\{[0-9]+\}$/.test(value);
}

function isSafePathArgument(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function isSafeWorktreeFolderNameArgument(value: unknown): value is string {
  return (
    isSafePathArgument(value) &&
    value.length <= 255 &&
    value !== '.' &&
    !value.includes('..') &&
    !/[/\\]/.test(value) &&
    !/[<>:"|?*\x00-\x1f]/.test(value) &&
    !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)
  );
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
    case 'stashChanges':
    case 'cloneRepository':
    case 'closeFileHistory':
    case 'loadMoreFileHistory':
    case 'closeRefComparison':
    case 'swapRefComparison':
      return hasOnlyFields(value, ['type']);
    case 'openCompareFileDiff':
      return (
        hasOnlyFields(value, ['type', 'payload']) &&
        Object.keys(value).length === 2 &&
        payload !== null &&
        hasOnlyFields(payload, ['filePath', 'oldPath', 'status']) &&
        isSafeRepoRelativePath(ownField(payload, 'filePath')) &&
        (ownField(payload, 'oldPath') === undefined || isSafeRepoRelativePath(ownField(payload, 'oldPath'))) &&
        isChangedFileStatus(ownField(payload, 'status'))
      );
    case 'compareFileRevisions':
      return (
        hasOnlyFields(value, ['type', 'payload']) &&
        Object.keys(value).length === 2 &&
        payload !== null &&
        hasOnlyFields(payload, ['olderHash', 'olderPath', 'newerHash', 'newerPath']) &&
        Object.keys(payload).length === 4 &&
        isCommitHash(ownField(payload, 'olderHash')) &&
        isSafeRepoRelativePath(ownField(payload, 'olderPath')) &&
        isCommitHash(ownField(payload, 'newerHash')) &&
        isSafeRepoRelativePath(ownField(payload, 'newerPath'))
      );
    case 'compareRevisionWithWorkingTree':
      return (
        hasOnlyFields(value, ['type', 'payload']) &&
        Object.keys(value).length === 2 &&
        payload !== null &&
        hasOnlyFields(payload, ['hash', 'filePathAtCommit', 'currentFilePath']) &&
        Object.keys(payload).length === 3 &&
        isCommitHash(ownField(payload, 'hash')) &&
        isSafeRepoRelativePath(ownField(payload, 'filePathAtCommit')) &&
        isSafeRepoRelativePath(ownField(payload, 'currentFilePath'))
      );
    case 'openFileAtRevision':
      return (
        hasOnlyFields(value, ['type', 'payload']) &&
        Object.keys(value).length === 2 &&
        payload !== null &&
        hasOnlyFields(payload, ['hash', 'filePathAtCommit']) &&
        Object.keys(payload).length === 2 &&
        isCommitHash(ownField(payload, 'hash')) &&
        isSafeRepoRelativePath(ownField(payload, 'filePathAtCommit'))
      );
    case 'inspectStash':
      return (
        hasOnlyFields(value, ['type', 'ref', 'hash']) &&
        isSafeStashRefArgument(ownField(value, 'ref')) &&
        isCommitHash(ownField(value, 'hash'))
      );
    case 'applyStash':
    case 'popStash':
    case 'dropStash':
      return hasOnlyFields(value, ['type', 'ref']) && isSafeStashRefArgument(ownField(value, 'ref'));
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
    case 'searchCommitsByFile': {
      if (
        !hasOnlyFields(value, ['type', 'payload']) ||
        Object.keys(value).length !== 2 ||
        payload === null ||
        !hasOnlyFields(payload, ['query', 'requestId']) ||
        Object.keys(payload).length !== 2
      ) {
        return false;
      }
      const query = ownField(payload, 'query');
      const requestId = ownField(payload, 'requestId');
      return (
        isSafeFileSearchQuery(query) &&
        typeof requestId === 'number' &&
        Number.isFinite(requestId) &&
        Number.isInteger(requestId) &&
        requestId >= 0
      );
    }
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
    case 'browseWorktreeParentFolder':
      if (!hasOnlyFields(value, ['type', 'payload']) || payload === null || !hasOnlyFields(payload, ['currentParentPath'])) {
        return false;
      }
      {
        const currentParentPath = ownField(payload, 'currentParentPath');
        return currentParentPath === undefined || isSafePathArgument(currentParentPath);
      }
    case 'submitCreateWorktree':
      if (!hasOnlyFields(value, ['type', 'payload']) || payload === null) {
        return false;
      }
      {
        const startPoint = ownField(payload, 'startPoint');
        return (
          hasOnlyFields(payload, [
            'branchName',
            'createBranch',
            'startPoint',
            'parentFolderPath',
            'folderName',
            'openInNewWindow',
          ]) &&
          isSafeRefArgument(ownField(payload, 'branchName')) &&
          typeof ownField(payload, 'createBranch') === 'boolean' &&
          (startPoint === undefined || isCommitHash(startPoint) || isSafeRefArgument(startPoint)) &&
          isSafePathArgument(ownField(payload, 'parentFolderPath')) &&
          isSafeWorktreeFolderNameArgument(ownField(payload, 'folderName')) &&
          typeof ownField(payload, 'openInNewWindow') === 'boolean'
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
    Array.isArray(p.worktrees) &&
    p.worktrees.every(isWorktreeInfoShape) &&
    (p.stashes === undefined ||
      (Array.isArray(p.stashes) && p.stashes.every(isStashInfoShape))) &&
    (p.remotes === undefined || (Array.isArray(p.remotes) && p.remotes.every((name: unknown) => isSafeRefArgument(name)))) &&
    Array.isArray(p.remoteGroups) &&
    Array.isArray(p.tags) &&
    Array.isArray(p.commits) &&
    typeof p.hasMoreCommits === 'boolean'
  );
}

function isStashInfoShape(value: unknown): value is StashInfo {
  if (
    !isSafeRecord(value) ||
    !hasOnlyFields(value, ['index', 'ref', 'hash', 'message', 'timestamp']) ||
    !Number.isSafeInteger(value.index) ||
    (value.index as number) < 0 ||
    !isSafeStashRefArgument(value.ref)
  ) {
    return false;
  }
  const refMatch = /^stash@\{([0-9]+)\}$/.exec(value.ref);
  return (
    refMatch !== null &&
    Number(refMatch[1]) === value.index &&
    typeof value.hash === 'string' &&
    /^[0-9a-f]{40}$/i.test(value.hash) &&
    typeof value.message === 'string' &&
    Number.isSafeInteger(value.timestamp) &&
    (value.timestamp as number) >= 0
  );
}

function isWorktreeInfoShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.headHash === 'string' &&
    (value.branchName === null || typeof value.branchName === 'string') &&
    typeof value.isDetached === 'boolean' &&
    typeof value.isBare === 'boolean' &&
    typeof value.isMain === 'boolean' &&
    typeof value.isCurrent === 'boolean' &&
    typeof value.isLocked === 'boolean' &&
    typeof value.isPrunable === 'boolean'
  );
}

export function isExtensionToWebviewMessage(value: unknown): value is ExtensionToWebviewMessage {
  if (
    isSafeRecord(value) &&
    hasOnlyFields(value, ['type']) &&
    (ownField(value, 'type') === 'clearFileHistory' || ownField(value, 'type') === 'clearRefComparison')
  ) {
    return true;
  }
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
    case 'fileHistoryLoaded':
      return (
        (payload.kind === 'file' || payload.kind === 'line') &&
        typeof payload.repoRoot === 'string' &&
        isSafeRepoRelativePath(payload.filePath) &&
        (payload.startLine === undefined ||
          (Number.isSafeInteger(payload.startLine) && (payload.startLine as number) > 0)) &&
        (payload.endLine === undefined ||
          (Number.isSafeInteger(payload.endLine) && (payload.endLine as number) > 0)) &&
        Array.isArray(payload.commits) &&
        payload.commits.every(isFileHistoryCommitShape) &&
        typeof payload.hasMore === 'boolean'
      );
    case 'refComparisonLoaded':
      return (
        typeof payload.repoRoot === 'string' &&
        isSafeRefArgument(payload.baseRef) &&
        typeof payload.baseLabel === 'string' &&
        isCommitHash(payload.baseHash) &&
        isSafeRefArgument(payload.targetRef) &&
        typeof payload.targetLabel === 'string' &&
        isCommitHash(payload.targetHash) &&
        Array.isArray(payload.commits) &&
        payload.commits.every(isCommitNodeShape) &&
        typeof payload.hasMoreCommits === 'boolean' &&
        Number.isSafeInteger(payload.behindCount) &&
        (payload.behindCount as number) >= 0 &&
        Array.isArray(payload.changedFiles) &&
        payload.changedFiles.every(
          (file: unknown) =>
            isSafeRecord(file) &&
            isChangedFileStatus(ownField(file, 'status')) &&
            isSafeRepoRelativePath(ownField(file, 'path')) &&
            (ownField(file, 'oldPath') === undefined || isSafeRepoRelativePath(ownField(file, 'oldPath'))),
        )
      );
    case 'fileHistoryAppended':
      return (
        isSafeRepoRelativePath(payload.filePath) &&
        Array.isArray(payload.commits) &&
        payload.commits.every(isFileHistoryCommitShape) &&
        typeof payload.hasMore === 'boolean'
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
    case 'fileSearchResults':
      return (
        isSafeRecord(value) &&
        hasOnlyFields(value, ['type', 'payload']) &&
        Object.keys(value).length === 2 &&
        isSafeRecord(payload) &&
        hasOnlyFields(payload, ['query', 'requestId', 'matchingHashes']) &&
        Object.keys(payload).length === 3 &&
        typeof ownField(payload, 'query') === 'string' &&
        (ownField(payload, 'query') as string).length >= 1 &&
        (ownField(payload, 'query') as string).length <= 500 &&
        !/[\x00-\x1f\x7f]/.test(ownField(payload, 'query') as string) &&
        typeof ownField(payload, 'requestId') === 'number' &&
        Number.isFinite(ownField(payload, 'requestId') as number) &&
        Number.isInteger(ownField(payload, 'requestId') as number) &&
        (ownField(payload, 'requestId') as number) >= 0 &&
        Array.isArray(ownField(payload, 'matchingHashes')) &&
        (ownField(payload, 'matchingHashes') as unknown[]).every(isCommitHash)
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
    case 'showCreateWorktreeDialog':
      return (
        isSafeRecord(value) &&
        hasOnlyFields(value, ['type', 'payload']) &&
        isSafeRecord(payload) &&
        hasOnlyFields(payload, [
          'repoRoot',
          'repoName',
          'defaultParentPath',
          'existingChildNames',
          'availableBranches',
          'allLocalBranchNames',
          'initialBranchName',
          'initialCreateBranch',
          'branchLocked',
          'startPoint',
        ]) &&
        isSafePathArgument(payload.repoRoot) &&
        typeof payload.repoName === 'string' &&
        payload.repoName.length > 0 &&
        payload.repoName.length <= 255 &&
        isSafePathArgument(payload.defaultParentPath) &&
        Array.isArray(payload.existingChildNames) &&
        payload.existingChildNames.every(
          (name: unknown) => isSafePathArgument(name) && !/[/\\]/.test(name),
        ) &&
        Array.isArray(payload.availableBranches) &&
        payload.availableBranches.every((branch: unknown) => isSafeRefArgument(branch)) &&
        Array.isArray(payload.allLocalBranchNames) &&
        payload.allLocalBranchNames.every((branch: unknown) => isSafeRefArgument(branch)) &&
        (payload.initialBranchName === undefined || isSafeRefArgument(payload.initialBranchName)) &&
        (payload.initialCreateBranch === undefined || typeof payload.initialCreateBranch === 'boolean') &&
        typeof payload.branchLocked === 'boolean' &&
        (payload.startPoint === undefined ||
          isCommitHash(payload.startPoint) ||
          isSafeRefArgument(payload.startPoint))
      );
    case 'worktreeParentFolderSelected':
      return (
        isSafeRecord(value) &&
        hasOnlyFields(value, ['type', 'payload']) &&
        isSafeRecord(payload) &&
        hasOnlyFields(payload, ['parentFolderPath', 'existingChildNames']) &&
        isSafePathArgument(payload.parentFolderPath) &&
        Array.isArray(payload.existingChildNames) &&
        payload.existingChildNames.every(
          (name: unknown) => isSafePathArgument(name) && !/[/\\]/.test(name),
        )
      );
    default:
      return false;
  }
}

function isFileHistoryCommitShape(value: unknown): value is FileHistoryCommit {
  if (!isSafeRecord(value)) {
    return false;
  }
  return (
    isCommitNodeShape(value) &&
    isSafeRepoRelativePath(ownField(value, 'filePathAtCommit')) &&
    (ownField(value, 'fileStatus') === undefined ||
      typeof ownField(value, 'fileStatus') === 'string')
  );
}

function isWorkspaceRepoInfoShape(value: unknown): value is WorkspaceRepoInfo {
  return (
    isSafeRecord(value) &&
    hasOnlyFields(value, [
      'repoRoot',
      'repoName',
      'commonDir',
      'currentBranch',
      'isDetachedHead',
      'isWorkspaceFolder',
    ]) &&
    typeof ownField(value, 'repoRoot') === 'string' &&
    ownField(value, 'repoRoot') !== '' &&
    typeof ownField(value, 'repoName') === 'string' &&
    ownField(value, 'repoName') !== '' &&
    typeof ownField(value, 'commonDir') === 'string' &&
    ownField(value, 'commonDir') !== '' &&
    (ownField(value, 'currentBranch') === undefined || typeof ownField(value, 'currentBranch') === 'string') &&
    (ownField(value, 'isDetachedHead') === undefined || typeof ownField(value, 'isDetachedHead') === 'boolean') &&
    (ownField(value, 'isWorkspaceFolder') === undefined || typeof ownField(value, 'isWorkspaceFolder') === 'boolean')
  );
}
