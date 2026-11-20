import type { ChangedFileStatus, CommitDetails, ExternalIntegrationsInfo, RepoSnapshot } from './git';

export type GitAction = 'fetch' | 'pull' | 'push' | 'createBranch';

export const GIT_ACTION_LABELS: Readonly<Record<GitAction, string>> = {
  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
  createBranch: 'New Branch',
};

export type WebviewToExtensionMessage =
  | { type: 'webviewReady' }
  | { type: 'openRepositoryPanel' }
  | { type: 'requestRefresh' }
  | { type: 'checkoutBranch'; payload: { branchName: string } }
  | { type: 'gitAction'; payload: { action: GitAction } }
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
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
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
  | { type: 'actionStatus'; payload: ActionStatusPayload };

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
    case 'gitAction':
      return payload !== null && isGitAction(ownField(payload, 'action'));
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
        (payload.workspacePath === null || typeof payload.workspacePath === 'string')
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
    default:
      return false;
  }
}
