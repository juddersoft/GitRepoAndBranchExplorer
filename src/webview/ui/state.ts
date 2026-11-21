import type { BranchInfo, CommitDetails, CommitNode, ExternalIntegrationsInfo, RefBadge, RepoSnapshot, TagInfo } from '../../types/git';

export const NODE_BRANCHES = 'branches';
export const NODE_REPO_ROOT = 'repoRoot';
export const NODE_TAGS = 'tags';
export const MAX_CACHED_COMMIT_DETAILS = 200;

export function remoteNodeKey(remoteName: string): string {
  return `remote:${remoteName}`;
}

export type RefKind = 'local' | 'remote' | 'tag';

/** A branch or tag that can be selected/inspected, regardless of which tree section it lives in. */
export interface RefTarget {
  kind: RefKind;
  /** Name Git understands: `feature/x`, `origin/feature/x` or `v1.0.0`. */
  name: string;
  /** Full ref, e.g. `refs/heads/feature/x`, `refs/remotes/origin/x` or `refs/tags/v1`. */
  fullName: string;
  tipHash: string;
  /** The branch record for local/remote refs; null for tags. */
  branch: BranchInfo | null;
}

export function branchRefTarget(branch: BranchInfo): RefTarget {
  return {
    kind: branch.isRemote ? 'remote' : 'local',
    name: branch.name,
    fullName: branch.fullName,
    tipHash: branch.tipHash,
    branch,
  };
}

export function tagRefTarget(tag: TagInfo): RefTarget {
  return { kind: 'tag', name: tag.name, fullName: tag.fullName, tipHash: tag.targetHash, branch: null };
}

export function listRefTargets(snapshot: RepoSnapshot): RefTarget[] {
  return [
    ...snapshot.localBranches.map(branchRefTarget),
    ...snapshot.remoteGroups.flatMap((group) => group.branches.map(branchRefTarget)),
    ...snapshot.tags.map(tagRefTarget),
  ];
}

export function findRefTarget(snapshot: RepoSnapshot, fullName: string | null): RefTarget | null {
  if (fullName === null) {
    return null;
  }
  return listRefTargets(snapshot).find((target) => target.fullName === fullName) ?? null;
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
  /** Branch/tag inspected via single-click (full ref name); its history is focused. Distinct from the checked-out branch. */
  selectedBranchFullName: string | null;
  /** Git-usable short name of the selected ref (e.g. `origin/main`), kept in sync with the snapshot. */
  selectedBranchRef: string | null;
  /** When false, the editor tab closes automatically once another sidebar view container is selected. */
  tabPinned: boolean;
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
    selectedBranchFullName: null,
    selectedBranchRef: null,
    tabPinned: false,
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

export function filterTags(tags: readonly TagInfo[], query: string): TagInfo[] {
  const q = normalizeQuery(query);
  return q === '' ? [...tags] : tags.filter((t) => t.name.toLowerCase().includes(q));
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

/** Selection patch for a ref (or `null` to clear it); the two fields always change together. */
export function selectRefPatch(target: RefTarget | null): Pick<ExplorerUiState, 'selectedBranchFullName' | 'selectedBranchRef'> {
  return { selectedBranchFullName: target?.fullName ?? null, selectedBranchRef: target?.name ?? null };
}

/** Pinned branches plus the selected ref, de-duplicated, in snapshot order. */
export function getFocusedRefs(snapshot: RepoSnapshot, state: ExplorerUiState): RefTarget[] {
  return listRefTargets(snapshot).filter(
    (target) => target.fullName === state.selectedBranchFullName || state.pinnedBranchFullNames.has(target.fullName),
  );
}

export function hasHistoryFocus(state: ExplorerUiState): boolean {
  return state.pinnedBranchFullNames.size > 0 || state.selectedBranchFullName !== null;
}

/** HEAD's commit: the checked-out branch tip, or the commit carrying the HEAD badge when detached. */
export function getHeadHash(snapshot: RepoSnapshot): string | null {
  const current = snapshot.localBranches.find((b) => b.isCurrent);
  if (current && !snapshot.isDetachedHead) {
    return current.tipHash;
  }
  return snapshot.commits.find((c) => c.refs.some((ref) => ref.kind === 'head'))?.hash ?? null;
}

export function isAncestorOfHead(snapshot: RepoSnapshot, hash: string): boolean {
  const head = getHeadHash(snapshot);
  return head !== null && collectReachableHashes(snapshot.commits, [head]).has(hash);
}

export function computeVisibleCommits(snapshot: RepoSnapshot, state: ExplorerUiState): CommitNode[] {
  let commits: readonly CommitNode[] = snapshot.commits;
  if (hasHistoryFocus(state)) {
    const tips = getFocusedRefs(snapshot, state).map((target) => target.tipHash);
    const reachable = collectReachableHashes(snapshot.commits, tips);
    commits = commits.filter((c) => reachable.has(c.hash));
  }
  return commits.filter((c) => commitMatchesQuery(c, state.historyFilterText));
}

/** Names of the branches/tags whose history is shown (selected ref first), or `[]` when showing everything. */
export function describeHistoryFocus(snapshot: RepoSnapshot, state: ExplorerUiState): string[] {
  const names = getFocusedRefs(snapshot, state).map((target) => target.name);
  const selected = state.selectedBranchRef;
  return selected !== null && names.includes(selected) ? [selected, ...names.filter((n) => n !== selected)] : names;
}

/** Why the history table is empty, so a filtered-out timeline never looks like a broken one. */
export function describeEmptyHistory(snapshot: RepoSnapshot, state: ExplorerUiState): string {
  if (snapshot.commits.length === 0) {
    return 'No commits yet.';
  }
  const loaded = new Set(snapshot.commits.map((c) => c.hash));
  const unloaded = getFocusedRefs(snapshot, state).filter((target) => !loaded.has(target.tipHash));
  if (state.historyFilterText.trim() === '' && unloaded.length > 0) {
    return `${unloaded.map((t) => t.name).join(', ')} points to a commit outside the loaded history window.`;
  }
  return 'No commits match the current filters.';
}

export interface RefToggleSummary {
  kind: BadgeKindToggle;
  label: string;
  /** Lower-case plural noun used in status sentences. */
  noun: string;
  enabled: boolean;
  /** Number of refs of this kind in the repository (HEAD is counted with local branches' toggle, not here). */
  count: number;
}

export function summarizeRefToggles(snapshot: RepoSnapshot | null, state: ExplorerUiState): RefToggleSummary[] {
  const remoteCount = snapshot?.remoteGroups.reduce((sum, group) => sum + group.branches.length, 0) ?? 0;
  return [
    { kind: 'local', label: 'Local Branches', noun: 'local branches', enabled: state.showLocalBranchBadges, count: snapshot?.localBranches.length ?? 0 },
    { kind: 'remote', label: 'Remote Branches', noun: 'remote branches', enabled: state.showRemoteBranchBadges, count: remoteCount },
    { kind: 'tag', label: 'Tags', noun: 'tags', enabled: state.showTagBadges, count: snapshot?.tags.length ?? 0 },
  ];
}

/**
 * One-line explanation of how the ref toggles affect the Branch / Tag column, or `null` when nothing
 * is hidden and every enabled kind has refs to show. Toggles hide labels, never commits.
 */
export function describeRefFilterStatus(snapshot: RepoSnapshot | null, state: ExplorerUiState): string | null {
  if (!snapshot) {
    return null;
  }
  const summaries = summarizeRefToggles(snapshot, state);
  if (summaries.every((s) => !s.enabled)) {
    return 'All ref labels are hidden';
  }
  const parts: string[] = [];
  const hidden = summaries.filter((s) => !s.enabled && s.count > 0);
  if (hidden.length > 0) {
    parts.push(`Hiding ${hidden.map((s) => `${s.noun} (${s.count})`).join(', ')}`);
  }
  const empty = summaries.filter((s) => s.enabled && s.count === 0);
  if (empty.length > 0) {
    parts.push(`No ${empty.map((s) => s.noun).join(' or ')} in this repository`);
  }
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

/** "Showing 3 of 120 commits" while history is narrowed, otherwise `null`. */
export function describeCommitCount(snapshot: RepoSnapshot | null, visibleCount: number): string | null {
  if (!snapshot || visibleCount === snapshot.commits.length) {
    return null;
  }
  return `Showing ${visibleCount} of ${snapshot.commits.length} commits`;
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
  const selectedRef = findRefTarget(snapshot, state.selectedBranchFullName);
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
    ...selectRefPatch(selectedRef),
    selectedCommitHash: selectedExists ? state.selectedCommitHash : null,
    expandedNodes,
  };
}
