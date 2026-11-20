import type { BranchInfo, CommitDetails, CommitNode, ExternalIntegrationsInfo, RefBadge, RepoSnapshot } from '../../types/git';

export const NODE_BRANCHES = 'branches';
export const NODE_REPO_ROOT = 'repoRoot';
export const MAX_CACHED_COMMIT_DETAILS = 200;

export function remoteNodeKey(remoteName: string): string {
  return `remote:${remoteName}`;
}

/**
 * Returns a new cache with `details` stored as the most recent entry, evicting the oldest entries
 * beyond `maxEntries` (Map iteration order is insertion order).
 */
export function cacheCommitDetails(
  cache: ReadonlyMap<string, CommitDetails>,
  details: CommitDetails,
  maxEntries = MAX_CACHED_COMMIT_DETAILS,
): Map<string, CommitDetails> {
  const next = new Map(cache);
  next.delete(details.hash);
  next.set(details.hash, details);
  for (const key of next.keys()) {
    if (next.size <= maxEntries) {
      break;
    }
    next.delete(key);
  }
  return next;
}

export type BadgeKindToggle = 'local' | 'remote' | 'tag';

export interface ExplorerUiState {
  snapshot: RepoSnapshot | null;
  errorMessage: string | null;
  isLoading: boolean;
  branchFilterText: string;
  historyFilterText: string;
  /** Branches isolated via the eye toggle; empty means every branch's history is shown. */
  pinnedBranchFullNames: Set<string>;
  showLocalBranchBadges: boolean;
  showRemoteBranchBadges: boolean;
  showTagBadges: boolean;
  selectedCommitHash: string | null;
  isSidebarCollapsed: boolean;
  expandedNodes: Set<string>;
  /** Commit message bodies and changed files, keyed by commit hash. */
  commitDetails: Map<string, CommitDetails>;
  integrations: ExternalIntegrationsInfo;
  /** True while the extension runs a mutating Git operation (fetch/pull/push/checkout/branch). */
  isBusy: boolean;
  busyMessage: string | null;
}

export function createInitialState(): ExplorerUiState {
  return {
    snapshot: null,
    errorMessage: null,
    isLoading: true,
    branchFilterText: '',
    historyFilterText: '',
    pinnedBranchFullNames: new Set(),
    showLocalBranchBadges: true,
    showRemoteBranchBadges: true,
    showTagBadges: true,
    selectedCommitHash: null,
    isSidebarCollapsed: false,
    expandedNodes: new Set([NODE_BRANCHES, NODE_REPO_ROOT]),
    commitDetails: new Map(),
    integrations: { gitGraphAvailable: false, gitGraphExtensionId: null, githubRemoteUrl: null },
    isBusy: false,
    busyMessage: null,
  };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function filterBranches(branches: readonly BranchInfo[], query: string): BranchInfo[] {
  const q = normalizeQuery(query);
  if (q === '') {
    return [...branches];
  }
  return branches.filter((b) => b.name.toLowerCase().includes(q) || b.displayName.toLowerCase().includes(q));
}

export function getAllBranches(snapshot: RepoSnapshot): BranchInfo[] {
  return [...snapshot.localBranches, ...snapshot.remoteGroups.flatMap((group) => group.branches)];
}

/** Pinned branches in snapshot order (local first, then remotes). */
export function getPinnedBranches(snapshot: RepoSnapshot, state: ExplorerUiState): BranchInfo[] {
  return getAllBranches(snapshot).filter((b) => state.pinnedBranchFullNames.has(b.fullName));
}

/** Walks `parents` from each tip; commits outside the loaded window simply end the walk. */
export function collectReachableHashes(commits: readonly CommitNode[], tipHashes: Iterable<string>): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c] as const));
  const reachable = new Set<string>();
  const stack = [...tipHashes];
  while (stack.length > 0) {
    const hash = stack.pop() as string;
    if (reachable.has(hash)) {
      continue;
    }
    const commit = byHash.get(hash);
    if (!commit) {
      continue;
    }
    reachable.add(hash);
    stack.push(...commit.parents);
  }
  return reachable;
}

export function commitMatchesQuery(commit: CommitNode, query: string): boolean {
  const q = normalizeQuery(query);
  if (q === '') {
    return true;
  }
  return (
    commit.subject.toLowerCase().includes(q) ||
    commit.authorName.toLowerCase().includes(q) ||
    commit.authorEmail.toLowerCase().includes(q) ||
    commit.hash.startsWith(q) ||
    commit.shortHash.startsWith(q) ||
    commit.refs.some((ref) => ref.label.toLowerCase().includes(q))
  );
}

export function computeVisibleCommits(snapshot: RepoSnapshot, state: ExplorerUiState): CommitNode[] {
  let commits: readonly CommitNode[] = snapshot.commits;
  if (state.pinnedBranchFullNames.size > 0) {
    const tips = getPinnedBranches(snapshot, state).map((b) => b.tipHash);
    const reachable = collectReachableHashes(snapshot.commits, tips);
    commits = commits.filter((c) => reachable.has(c.hash));
  }
  return commits.filter((c) => commitMatchesQuery(c, state.historyFilterText));
}

export function filterVisibleBadges(refs: readonly RefBadge[], state: ExplorerUiState): RefBadge[] {
  return refs.filter((ref) => {
    switch (ref.kind) {
      case 'head':
      case 'localBranch':
        return state.showLocalBranchBadges;
      case 'remoteBranch':
        return state.showRemoteBranchBadges;
      case 'tag':
        return state.showTagBadges;
    }
  });
}

export function toggleSetMember<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) {
    next.add(value);
  }
  return next;
}

/**
 * Applies a fresh snapshot: drops pins/selection that no longer exist and expands
 * remotes that have not been seen before (remotes the user collapsed stay collapsed).
 */
export function reconcileStateWithSnapshot(
  state: ExplorerUiState,
  snapshot: RepoSnapshot,
  knownRemoteNames: ReadonlySet<string>,
): ExplorerUiState {
  const fullNames = new Set(getAllBranches(snapshot).map((b) => b.fullName));
  const pinned = new Set([...state.pinnedBranchFullNames].filter((name) => fullNames.has(name)));
  const selectedExists = snapshot.commits.some((c) => c.hash === state.selectedCommitHash);
  const expandedNodes = new Set(state.expandedNodes);
  for (const group of snapshot.remoteGroups) {
    if (!knownRemoteNames.has(group.remoteName)) {
      expandedNodes.add(remoteNodeKey(group.remoteName));
    }
  }
  return {
    ...state,
    snapshot,
    errorMessage: null,
    isLoading: false,
    pinnedBranchFullNames: pinned,
    selectedCommitHash: selectedExists ? state.selectedCommitHash : null,
    expandedNodes,
  };
}
