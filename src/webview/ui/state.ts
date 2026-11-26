import type { SyncStatePayload, TrackingIndicatorOrder } from '../../types/messages';
import type { BranchInfo, CommitDetails, CommitNode, ExternalIntegrationsInfo, RefBadge, RepoSnapshot, TagInfo, WorkspaceRepoInfo } from '../../types/git';
import { collectAncestorFolderIds } from './branchFolderTree';

export const NODE_BRANCHES = 'branches';
export const NODE_TAGS = 'tags';
export const NODE_STASHES = 'stashes';
export const MAX_CACHED_COMMIT_DETAILS = 200;

export function normalizeRepoKey(repoRoot: string): string {
  let normalized = repoRoot.replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.replace(/^[A-Z](?=:\/)/, (drive) => drive.toLowerCase());
}

export function repoNodeKey(repoRoot: string): string {
  return `repo:${normalizeRepoKey(repoRoot)}`;
}

export function normalizeTreeNodeKey(key: string): string {
  return key.startsWith('repo:') ? repoNodeKey(key.slice('repo:'.length)) : key;
}

function normalizeTreeNodeKeys(keys: ReadonlySet<string>): Set<string> {
  return new Set([...keys].map(normalizeTreeNodeKey));
}

export function remoteNodeKey(remoteName: string): string {
  return `remote:${remoteName}`;
}

export function reconcileActiveRepoExpansion(
  expandedNodes: ReadonlySet<string>,
  collapsedRepoNodes: ReadonlySet<string>,
  activeRepoRoot: string | null,
  activeChanged: boolean,
): Set<string> {
  const next = normalizeTreeNodeKeys(expandedNodes);
  if (!activeRepoRoot || !activeChanged) {
    return next;
  }
  const key = repoNodeKey(activeRepoRoot);
  if (!normalizeTreeNodeKeys(collapsedRepoNodes).has(key)) {
    next.add(key);
  }
  return next;
}

export function toggleNodeExpansion(
  expandedNodes: ReadonlySet<string>,
  collapsedRepoNodes: ReadonlySet<string>,
  key: string,
): Pick<ExplorerUiState, 'expandedNodes' | 'collapsedRepoNodes'> {
  const normalizedKey = normalizeTreeNodeKey(key);
  const expanded = toggleSetMember(normalizeTreeNodeKeys(expandedNodes), normalizedKey);
  const collapsed = normalizeTreeNodeKeys(collapsedRepoNodes);
  if (normalizedKey.startsWith('repo:')) {
    if (expanded.has(normalizedKey)) {
      collapsed.delete(normalizedKey);
    } else {
      collapsed.add(normalizedKey);
    }
  }
  return { expandedNodes: expanded, collapsedRepoNodes: collapsed };
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

export type TrackingKind = 'synced' | 'diverged' | 'noUpstream' | 'gone';

/** How a local branch relates to its upstream, with the text the tree shows for it. */
export interface TrackingSummary {
  kind: TrackingKind;
  /** Outgoing indicator: `↑<n>` (commits to push), or `↑–` when unknown. */
  up: string;
  /** Incoming indicator: `↓<n>` (commits to pull), or `↓–` when unknown. */
  down: string;
  /** Tooltip. */
  title: string;
  /** Short screen-reader phrase. */
  label: string;
}

function commitCount(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

/** Up/down indicators for a local branch; `null` for remote branches, which have no upstream of their own. */
export function trackingSummary(branch: BranchInfo): TrackingSummary | null {
  if (branch.isRemote) {
    return null;
  }
  if (!branch.upstream) {
    return {
      kind: 'noUpstream',
      up: '\u2191\u2013',
      down: '\u2193\u2013',
      title: 'No upstream branch is configured, so there is nothing to compare against.',
      label: 'no upstream branch',
    };
  }
  if (branch.upstreamGone) {
    return {
      kind: 'gone',
      up: '\u2191\u2013',
      down: '\u2193\u2013',
      title: `Upstream ${branch.upstream} no longer exists on the remote.`,
      label: `upstream ${branch.upstream} is gone`,
    };
  }
  const synced = branch.ahead === 0 && branch.behind === 0;
  return {
    kind: synced ? 'synced' : 'diverged',
    up: `\u2191${branch.ahead}`,
    down: `\u2193${branch.behind}`,
    title: synced
      ? `Up to date with ${branch.upstream}: nothing to push or pull.`
      : `${commitCount(branch.ahead)} to push, ${commitCount(branch.behind)} to pull (${branch.upstream}).`,
    label: synced
      ? `up to date with ${branch.upstream}`
      : `${commitCount(branch.ahead)} to push, ${commitCount(branch.behind)} to pull`,
  };
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
  workspaceRepos: WorkspaceRepoInfo[];
  activeRepoRoot: string | null;
  errorMessage: string | null;
  isLoading: boolean;
  /** True while the next older-commit page is being fetched. */
  isLoadingMore: boolean;
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
  /** Whether the sidebar shows the "Checked Out" pill (the check icon and accent bar always mark HEAD). */
  showCheckedOutBadge: boolean;
  /** Whether folder rows in the sidebar show their branch counts. */
  showFolderCounts: boolean;
  /** Preferred branch ahead/behind counter order. */
  trackingOrder: TrackingIndicatorOrder;
  showLocalBranchBadges: boolean;
  showRemoteBranchBadges: boolean;
  showTagBadges: boolean;
  selectedCommitHash: string | null;
  expandedNodes: Set<string>;
  /** Repository roots the user explicitly collapsed, retained across repository switches. */
  collapsedRepoNodes: Set<string>;
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
    workspaceRepos: [],
    activeRepoRoot: null,
    errorMessage: null,
    isLoading: true,
    isLoadingMore: false,
    branchFilterText: '',
    historyFilterText: '',
    pinnedBranchFullNames: new Set(),
    selectedBranchFullName: null,
    selectedBranchRef: null,
    tabPinned: false,
    showCheckedOutBadge: true,
    showFolderCounts: true,
    trackingOrder: 'vscode',
    showLocalBranchBadges: true,
    showRemoteBranchBadges: true,
    showTagBadges: true,
    selectedCommitHash: null,
    expandedNodes: new Set([NODE_BRANCHES]),
    collapsedRepoNodes: new Set(),
    commitDetails: new Map(),
    integrations: {
      gitGraphAvailable: false,
      gitGraphExtensionId: null,
      githubRemoteUrl: null,
      remoteWebUrl: null,
      remoteProvider: null,
      remoteProviderName: null,
    },
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

type SelectionFields = Pick<ExplorerUiState, 'selectedBranchFullName' | 'selectedBranchRef' | 'pinnedBranchFullNames'>;

/** The part of the UI state that the sidebar tree and the editor timeline keep identical. */
export function selectionFromState(state: SelectionFields): SyncStatePayload {
  return {
    selectedBranchFullName: state.selectedBranchFullName,
    selectedBranchRef: state.selectedBranchRef,
    pinnedBranchFullNames: [...state.pinnedBranchFullNames],
  };
}

/** Inverse of {@link selectionFromState}, for applying a selection received from the other view. */
export function selectionPatch(selection: SyncStatePayload): SelectionFields {
  return {
    selectedBranchFullName: selection.selectedBranchFullName,
    selectedBranchRef: selection.selectedBranchRef,
    pinnedBranchFullNames: new Set(selection.pinnedBranchFullNames),
  };
}

/**
 * Drops pins and a selection that do not exist in `snapshot` (pins must be branches) and re-derives the
 * selected ref's short name from it, so a stale or forged selection can never name a ref Git does not have.
 * Without a snapshot there is nothing to check against, so the selection is returned unchanged.
 */
export function normalizeSelection(snapshot: RepoSnapshot | null, selection: SyncStatePayload): SyncStatePayload {
  if (snapshot === null) {
    return selection;
  }
  const branchNames = new Set(getAllBranches(snapshot).map((b) => b.fullName));
  const selected = findRefTarget(snapshot, selection.selectedBranchFullName);
  return {
    ...selectRefPatch(selected),
    pinnedBranchFullNames: [...new Set(selection.pinnedBranchFullNames)].filter((name) => branchNames.has(name)),
  };
}

export function isSameSelection(a: SyncStatePayload, b: SyncStatePayload): boolean {
  return (
    a.selectedBranchFullName === b.selectedBranchFullName &&
    a.selectedBranchRef === b.selectedBranchRef &&
    a.pinnedBranchFullNames.length === b.pinnedBranchFullNames.length &&
    a.pinnedBranchFullNames.every((name, i) => name === b.pinnedBranchFullNames[i])
  );
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
  folderExpansionStateLoaded = false,
): ExplorerUiState {
  const fullNames = new Set(getAllBranches(snapshot).map((b) => b.fullName));
  const pinned = new Set([...state.pinnedBranchFullNames].filter((name) => fullNames.has(name)));
  const selectedRef = findRefTarget(snapshot, state.selectedBranchFullName);
  const selectedExists = snapshot.commits.some((c) => c.hash === state.selectedCommitHash);
  const expandedNodes = normalizeTreeNodeKeys(state.expandedNodes);
  const collapsedRepoNodes = normalizeTreeNodeKeys(state.collapsedRepoNodes);
  const repositoryKey = repoNodeKey(snapshot.repoRoot);
  if (!collapsedRepoNodes.has(repositoryKey)) {
    expandedNodes.add(repositoryKey);
  }
  for (const group of snapshot.remoteGroups) {
    if (!knownRemoteNames.has(group.remoteName)) {
      expandedNodes.add(remoteNodeKey(group.remoteName));
    }
  }
  const currentBranch = snapshot.localBranches.find((branch) => branch.isCurrent);
  const previousCurrentBranch = state.snapshot?.localBranches.find((branch) => branch.isCurrent);
  const shouldRevealCurrent =
    currentBranch !== undefined &&
    ((state.snapshot === null && !folderExpansionStateLoaded) ||
      (state.snapshot !== null && previousCurrentBranch?.fullName !== currentBranch.fullName));
  if (shouldRevealCurrent) {
    for (const id of collectAncestorFolderIds(
      snapshot.localBranches,
      'local',
      new Set([currentBranch.fullName]),
    )) {
      expandedNodes.add(id);
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
    collapsedRepoNodes,
  };
}
