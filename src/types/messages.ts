import type { ChangedFileStatus, CommitDetails, ExternalIntegrationsInfo, RepoSnapshot } from './git';

export type GitAction =
  | 'fetch'
  | 'pull'
  | 'push'
  | 'createBranch'
  | 'merge'
  | 'rebase'
  | 'cherryPick'
  | 'revert'
  | 'deleteBranch'
  | 'checkoutRemoteBranch';

export const GIT_ACTION_LABELS: Readonly<Record<GitAction, string>> = {
  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
  createBranch: 'New Branch',
  merge: 'Merge',
  rebase: 'Rebase',
  cherryPick: 'Cherry-Pick',
  revert: 'Revert',
  deleteBranch: 'Delete Branch',
  checkoutRemoteBranch: 'Check Out as Local Branch',
};

/** What a `gitAction` must carry in `target`: nothing, a ref name (branch/tag), or a full commit hash. */
export type GitActionTargetKind = 'none' | 'ref' | 'commit';

export const GIT_ACTION_TARGETS: Readonly<Record<GitAction, GitActionTargetKind>> = {
  fetch: 'none',
  pull: 'none',
  push: 'none',
  createBranch: 'none',
  merge: 'ref',
  rebase: 'ref',
  cherryPick: 'commit',
  revert: 'commit',
  deleteBranch: 'ref',
  checkoutRemoteBranch: 'ref',
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
  | { type: 'syncState'; payload: SyncStatePayload }
  | { type: 'checkoutBranch'; payload: { branchName: string } }
  | { type: 'gitAction'; payload: GitActionPayload }
  | { type: 'createBranchAtRef'; payload: { startPoint: string } }
  | { type: 'setTabPinned'; payload: { pinned: boolean } }
  | { type: 'copyCommitHash'; payload: { hash: string } }
  | { type: 'requestCommitDetails'; payload: { hash: string } }
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
}

export interface RepoErrorPayload {
  message: string;
  code?: string;
}

export type ExtensionToWebviewMessage =
  | { type: 'initState'; payload: InitStatePayload }
  | { type: 'repoSnapshot'; payload: RepoSnapshot }
  | { type: 'repoError'; payload: RepoErrorPayload }
  | { type: 'commitDetails'; payload: CommitDetails }
  | { type: 'integrationsInfo'; payload: ExternalIntegrationsInfo }
  | { type: 'actionStatus'; payload: ActionStatusPayload }
  | { type: 'syncState'; payload: SyncStatePayload };

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
  return FORBIDDEN_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(value, key));
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isGitAction(value: unknown): value is GitAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GIT_ACTION_LABELS, value);
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
  if (payload === null) {
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
    case 'ref':
      return isSafeRefArgument(target);
    case 'commit':
      return isCommitHash(target);
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
      return true;
    case 'checkoutBranch': {
      const branchName = payload === null ? undefined : ownField(payload, 'branchName');
      return typeof branchName === 'string' && branchName.length > 0 && branchName.length <= MAX_BRANCH_NAME_LENGTH;
    }
    case 'syncState':
      return isSyncStatePayload(payload);
    case 'gitAction':
      return isValidGitActionPayload(payload);
    case 'createBranchAtRef': {
      const startPoint = payload === null ? undefined : ownField(payload, 'startPoint');
      return isCommitHash(startPoint) || isSafeRefArgument(startPoint);
    }
    case 'setTabPinned':
      return payload !== null && typeof ownField(payload, 'pinned') === 'boolean';
    case 'copyCommitHash':
    case 'requestCommitDetails':
    case 'openCommitOnGitHub':
      return payload !== null && isCommitHash(ownField(payload, 'hash'));
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
    Array.isArray(p.remoteGroups) &&
    Array.isArray(p.tags) &&
    Array.isArray(p.commits)
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
        (payload.tabPinned === undefined || typeof payload.tabPinned === 'boolean')
      );
    case 'repoSnapshot':
      return isRepoSnapshotShape(payload);
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
        (payload.githubRemoteUrl === null || typeof payload.githubRemoteUrl === 'string')
      );
    case 'actionStatus':
      return (
        typeof payload.busy === 'boolean' &&
        (payload.message === undefined ||
          (typeof payload.message === 'string' && payload.message.length <= MAX_ACTION_STATUS_LENGTH))
      );
    case 'syncState':
      return isSyncStatePayload(payload);
    default:
      return false;
  }
}
