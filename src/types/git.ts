import type { RemoteProvider } from '../git/remoteUrlBuilder';

export interface BranchInfo {
  /** Short name, e.g. `featurebranch3` (local) or `origin/featurebranch3` (remote). */
  name: string;
  /** Name without the `<remote>/` prefix for remote branches; same as `name` for local branches. */
  displayName: string;
  /** Full ref, e.g. `refs/heads/featurebranch3` or `refs/remotes/origin/featurebranch3`. */
  fullName: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
  tipHash: string;
  upstream: string | null;
  /** Commits on this branch that are not on its upstream (to push); 0 when there is no usable upstream. */
  ahead: number;
  /** Commits on the upstream that are not on this branch (to pull); 0 when there is no usable upstream. */
  behind: number;
  /** The configured upstream no longer exists (Git reports `[gone]`), so `ahead`/`behind` are unknown. */
  upstreamGone: boolean;
  /** Path of the worktree currently holding this local branch, if any. */
  worktreePath?: string | null;
}

export interface WorktreeInfo {
  path: string;
  headHash: string;
  branchName: string | null;
  isDetached: boolean;
  isBare: boolean;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isPrunable: boolean;
}

export interface StashInfo {
  /** Zero-based stash stack index. */
  index: number;
  /** Reflog selector, e.g. `stash@{0}`. */
  ref: string;
  /** Full 40-character commit SHA. */
  hash: string;
  /** Stash subject / summary. */
  message: string;
  /** Unix epoch seconds. */
  timestamp: number;
}

export interface WorkingTreeFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  originalPath?: string;
}

export interface RemoteGroup {
  remoteName: string;
  branches: BranchInfo[];
  defaultBranch?: string;
  url?: string;
  destinationKind?: 'hosted' | 'localPath' | 'other';
  providerName?: string;
}

export interface TagInfo {
  name: string;
  fullName: string;
  /** Commit the tag points at (annotated tags are peeled to their commit). */
  targetHash: string;
}

export interface RefBadge {
  kind: 'head' | 'localBranch' | 'remoteBranch' | 'tag';
  label: string;
}

export interface CommitNode {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authorDateIso: string;
  /** Unix epoch seconds. */
  authorTimestamp: number;
  refs: RefBadge[];
}

export type ChangedFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangedFileEntry {
  status: ChangedFileStatus;
  /** Repository-relative path, using `/` separators (the destination path for renames/copies). */
  path: string;
  /** Source path for renames (`R`) and copies (`C`). */
  oldPath?: string;
}

export interface CommitDetails {
  hash: string;
  /** Full commit message (subject and body). */
  body: string;
  files: ChangedFileEntry[];
}

export interface ExternalIntegrationsInfo {
  gitGraphAvailable: boolean;
  gitGraphExtensionId: string | null;
  /** Normalized `https://github.com/<owner>/<repo>` URL for `origin`, if it is hosted on GitHub. */
  githubRemoteUrl: string | null;
  /** Normalized repository URL for any supported hosting provider. */
  remoteWebUrl?: string | null;
  remoteProvider?: RemoteProvider | null;
  remoteProviderName?: string | null;
}

export interface WorkspaceRepoInfo {
  repoRoot: string;
  repoName: string;
  commonDir: string;
  currentBranch?: string;
  isDetachedHead?: boolean;
}

export interface RepoSnapshot {
  repoName: string;
  repoRoot: string;
  /** Branch name, or `HEAD (<8-char sha>)` when detached. */
  currentBranch: string;
  isDetachedHead: boolean;
  localBranches: BranchInfo[];
  /** Configured Git remotes, including remotes that have no fetched branch refs yet. */
  remotes?: string[];
  remoteGroups: RemoteGroup[];
  worktrees: WorktreeInfo[];
  stashes?: StashInfo[];
  tags: TagInfo[];
  commits: CommitNode[];
  hasMoreCommits: boolean;
}
