import type { CommitNode, RepoSnapshot, StashInfo, WorktreeInfo } from '../../types/git';
import type { BranchInfo } from '../../types/git';
import type { GitAction, TrackingIndicatorOrder } from '../../types/messages';
import { planTrackedFetch } from '../../git/trackedFetch';
import { parseUpstreamRef } from '../../git/remoteUrlBuilder';
import type { ExplorerUiState, RefTarget } from './state';
import { getHeadHash, isAncestorOfHead } from './state';

export type MenuActionId =
  | 'checkout'
  | 'checkoutRemote'
  | 'merge'
  | 'rebase'
  | 'pull'
  | 'push'
  | 'pushAndOpenPr'
  | 'createPrInBrowser'
  | 'fetch'
  | 'fetchTracked'
  | 'newBranch'
  | 'refresh'
  | 'toggleCheckedOutBadge'
  | 'toggleFolderCounts'
  | 'toggleTrackingOrder'
  | 'createBranchHere'
  | 'createTag'
  | 'deleteTag'
  | 'pushTag'
  | 'renameBranch'
  | 'untrackBranch'
  | 'publishRepository'
  | 'isolate'
  | 'deleteBranch'
  | 'createWorktree'
  | 'openWorktree'
  | 'removeWorktree'
  | 'copyWorktreePath'
  | 'stashChanges'
  | 'inspectStash'
  | 'applyStash'
  | 'popStash'
  | 'dropStash'
  | 'cherryPick'
  | 'revert'
  | 'revertMerge'
  | 'resetMixed'
  | 'resetHard'
  | 'copyHash'
  | 'openGitGraph'
  | 'openRepoInBrowser'
  | 'openBranchInBrowser'
  | 'openCommitInBrowser'
  | 'openGitHub';

export type MenuEntry =
  | {
      kind: 'item';
      id: MenuActionId;
      label: string;
      enabled: boolean;
      reason?: string;
      gitAction?: GitAction;
      danger?: boolean;
    }
  | { kind: 'separator' };

const BUSY_REASON = 'Another Git operation is running.';
const DETACHED_REASON = 'HEAD is detached; check out a branch first.';

function item(
  id: MenuActionId,
  label: string,
  disabledReason?: string,
  danger = false,
): Extract<MenuEntry, { kind: 'item' }> {
  return disabledReason === undefined
    ? { kind: 'item', id, label, enabled: true, ...(danger ? { danger: true } : {}) }
    : { kind: 'item', id, label, enabled: false, reason: disabledReason, ...(danger ? { danger: true } : {}) };
}

function gitActionItem(
  id: MenuActionId,
  label: string,
  gitAction: GitAction,
  disabledReason?: string,
  danger = false,
): Extract<MenuEntry, { kind: 'item' }> {
  return { ...item(id, label, disabledReason, danger), gitAction };
}

const SEPARATOR: MenuEntry = { kind: 'separator' };

/** First reason an action cannot run, in priority order; `undefined` means it is available. */
function firstReason(...reasons: Array<string | false | undefined>): string | undefined {
  return reasons.find((reason): reason is string => typeof reason === 'string');
}

/** Resolve a local or remote branch to its remote branch and return a matching default branch. */
export function resolveDefaultBranch(snapshot: RepoSnapshot, branch: BranchInfo): string | undefined {
  let remoteName: string | null;
  let remoteBranch: string | null;
  if (branch.isRemote) {
    remoteName = branch.remoteName;
    remoteBranch = branch.displayName;
  } else {
    const remoteNames = [
      ...new Set([
        ...(snapshot.remotes ?? []),
        ...snapshot.remoteGroups.map((group) => group.remoteName),
      ]),
    ];
    const upstream = branch.upstream ? parseUpstreamRef(branch.upstream, remoteNames) : null;
    remoteName = upstream?.remoteName ?? null;
    remoteBranch = upstream?.remoteBranch ?? null;
  }
  if (!remoteName || !remoteBranch) {
    return undefined;
  }
  const remote = snapshot.remoteGroups.find((group) => group.remoteName === remoteName);
  return remote?.defaultBranch === remoteBranch ? remote.defaultBranch : undefined;
}

/** Why Pull/Push cannot run for the checked-out branch; `undefined` when allowed (push may publish a new upstream). */
export function pullPushDisabledReason(action: 'pull' | 'push', isDetachedHead: boolean, upstream: string | null): string | undefined {
  if (isDetachedHead) {
    return DETACHED_REASON;
  }
  if (action === 'pull' && (upstream === null || upstream === '')) {
    return 'No upstream branch is configured for the checked-out branch.';
  }
  return undefined;
}

/** Right-click menu for a local branch, remote branch or tag in the branch tree. */
export function buildRefMenu(snapshot: RepoSnapshot, state: ExplorerUiState, target: RefTarget): MenuEntry[] {
  const busy = state.isBusy && BUSY_REASON;
  const detached = snapshot.isDetachedHead;
  const isCheckedOut = target.kind === 'local' && target.branch?.isCurrent === true;
  const isCheckedOutInOtherWorktree =
    target.kind === 'local' && Boolean(target.branch?.worktreePath) && !target.branch?.isCurrent;
  const hasCurrentBranch = !detached && snapshot.localBranches.some((branch) => branch.isCurrent);
  const currentName = detached ? 'Current Branch' : snapshot.currentBranch;

  const integrateReason = (alreadyMergedCheck: boolean): string | undefined =>
    firstReason(
      busy,
      isCheckedOut && 'This is the checked-out branch.',
      detached && DETACHED_REASON,
      alreadyMergedCheck && isAncestorOfHead(snapshot, target.tipHash) && 'Already part of the current branch history.',
    );

  const merge = item('merge', `Merge into ${currentName}`, integrateReason(true));
  const rebase = item('rebase', `Rebase ${currentName} onto This`, integrateReason(false));
  const createBranch = item('createBranchHere', 'Create Branch from Here\u2026', firstReason(busy));
  const resetReason = firstReason(
    busy,
    detached && DETACHED_REASON,
    !hasCurrentBranch && 'No branch is checked out.',
  );
  const resetEntries = [
    item('resetMixed', `Reset ${currentName} to Here — Keep Changes (--mixed)…`, resetReason),
    item('resetHard', `Reset ${currentName} to Here — Delete Changes (--hard)…`, resetReason),
  ];

  if (target.kind === 'tag') {
    const hasRemotes = (snapshot.remotes?.length ?? 0) > 0 || snapshot.remoteGroups.length > 0;
    return [
      createBranch,
      SEPARATOR,
      gitActionItem(
        'pushTag',
        'Push Tag to Remote\u2026',
        'pushTag',
        firstReason(busy, !hasRemotes && 'No remotes configured.'),
      ),
      SEPARATOR,
      merge,
      rebase,
      SEPARATOR,
      ...resetEntries,
      SEPARATOR,
      gitActionItem('deleteTag', 'Delete Tag\u2026', 'deleteTag', firstReason(busy), true),
    ];
  }

  const isolate = item(
    'isolate',
    state.pinnedBranchFullNames.has(target.fullName) ? 'Stop Isolating in History' : 'Show Only This Branch in History',
  );

  if (target.kind === 'remote') {
    const remoteWebReason = state.integrations.remoteWebUrl
      ? undefined
      : 'This repository has no supported remote web URL.';
    const defaultBranch = target.branch
      ? resolveDefaultBranch(snapshot, target.branch)
      : undefined;
    const createPrReason = remoteWebReason
      ?? (defaultBranch
        ? `Cannot create a pull request from the default branch (${defaultBranch}).`
        : undefined);
    return [
      item('checkoutRemote', 'Check Out as Local Tracking Branch\u2026', firstReason(busy)),
      SEPARATOR,
      merge,
      rebase,
      SEPARATOR,
      ...resetEntries,
      SEPARATOR,
      createBranch,
      isolate,
      SEPARATOR,
      item('fetch', 'Fetch', firstReason(busy)),
      SEPARATOR,
      item('createPrInBrowser', 'Create Pull Request in Browser', createPrReason),
      item('openBranchInBrowser', 'Open Branch in Browser', remoteWebReason),
    ];
  }

  const branch = target.branch;
  const hasUpstream = branch?.upstream != null && branch.upstream !== '';
  const trackedWebReason = firstReason(
    !hasUpstream && 'No upstream branch is configured.',
    branch?.upstreamGone === true && `Upstream ${branch.upstream ?? ''} no longer exists on the remote.`,
    !state.integrations.remoteWebUrl && 'This repository has no supported remote web URL.',
  );
  const defaultBranch = !trackedWebReason && branch
    ? resolveDefaultBranch(snapshot, branch)
    : undefined;
  const createPrReason = trackedWebReason
    ?? (defaultBranch
      ? `Cannot create a pull request from the default branch (${defaultBranch}).`
      : undefined);
  const pushAndOpenPrReason = firstReason(
    busy,
    !state.integrations.remoteWebUrl && 'This repository has no supported remote web URL.',
    defaultBranch && `Cannot create a pull request from the default branch (${defaultBranch}).`,
  );
  return [
    item(
      'checkout',
      'Check Out',
      firstReason(busy, isCheckedOut && 'Already checked out.', isCheckedOutInOtherWorktree && 'Checked out in another worktree'),
    ),
    ...(isCheckedOutInOtherWorktree
      ? [item('openWorktree', 'Open Worktree in New Window', firstReason(busy))]
      : []),
    SEPARATOR,
    merge,
    rebase,
    SEPARATOR,
    ...resetEntries,
    SEPARATOR,
    item('pull', 'Pull', firstReason(busy, !isCheckedOut && 'Check out this branch first.', !hasUpstream && 'No upstream branch is configured.')),
    item('push', hasUpstream ? 'Push' : 'Publish Branch', firstReason(busy)),
    item(
      'pushAndOpenPr',
      'Push and Open PR in Browser',
      pushAndOpenPrReason,
    ),
    item('fetch', 'Fetch', firstReason(busy)),
    SEPARATOR,
    item('createPrInBrowser', 'Create Pull Request in Browser', createPrReason),
    item('openBranchInBrowser', 'Open Branch in Browser', trackedWebReason),
    SEPARATOR,
    createBranch,
    ...(!isCheckedOut && !isCheckedOutInOtherWorktree
      ? [item('createWorktree', 'Create Worktree…', firstReason(busy))]
      : []),
    item(
      'stashChanges',
      'Stash Changes...',
      firstReason(busy, !branch?.isCurrent && 'Only available on the checked-out branch.'),
    ),
    item('renameBranch', 'Rename Branch\u2026', firstReason(busy)),
    item(
      'untrackBranch',
      'Untrack Remote Branch',
      firstReason(busy, !hasUpstream && 'Branch is not tracking a remote branch.'),
    ),
    isolate,
    SEPARATOR,
    item(
      'deleteBranch',
      'Delete Branch\u2026',
      firstReason(
        busy,
        isCheckedOut && 'Cannot delete the checked-out branch.',
        isCheckedOutInOtherWorktree && 'Cannot delete a branch checked out in a worktree',
        detached && DETACHED_REASON,
      ),
    ),
  ];
}

/** Right-click menu for the repository header row in the branch tree. */
export function buildRepoMenu(
  snapshot: RepoSnapshot,
  state: ExplorerUiState,
  hasRemotes = true,
): MenuEntry[] {
  const busy = state.isBusy && BUSY_REASON;
  const current = snapshot.localBranches.find((branch) => branch.isCurrent);
  const noBranch = !snapshot.isDetachedHead && current === undefined && 'No branch is checked out yet.';
  const nothingToFetch = planTrackedFetch(snapshot.localBranches, snapshot.remoteGroups).remotes.length === 0;

  const pull = firstReason(
    busy,
    noBranch,
    pullPushDisabledReason('pull', snapshot.isDetachedHead, current?.upstream ?? null),
    current?.upstreamGone === true && `Upstream ${current.upstream ?? ''} no longer exists on the remote.`,
  );
  const push = firstReason(busy, noBranch, pullPushDisabledReason('push', snapshot.isDetachedHead, current?.upstream ?? null));
  const webReason = firstReason(
    busy,
    snapshot.isDetachedHead && DETACHED_REASON,
    noBranch,
    !state.integrations.remoteWebUrl && 'This repository has no supported remote web URL.',
  );
  const defaultBranch = !webReason && current
    ? resolveDefaultBranch(snapshot, current)
    : undefined;
  const createPrReason = webReason
    ?? (defaultBranch
      ? `Cannot create a pull request from the default branch (${defaultBranch}).`
      : undefined);
  const pushAndOpenPrReason = webReason
    ?? (defaultBranch
      ? `Cannot create a pull request from the default branch (${defaultBranch}).`
      : undefined);

  return [
    ...(!hasRemotes
      ? [item('publishRepository', 'Publish Repository / Add Remote\u2026', firstReason(busy)), SEPARATOR]
      : []),
    item('fetchTracked', 'Fetch', firstReason(busy, nothingToFetch && 'No local branch tracks a remote branch.')),
    item('pull', 'Pull', pull),
    item('push', current?.upstream ? 'Push' : 'Publish Branch', push),
    item('pushAndOpenPr', 'Push and Open PR in Browser', pushAndOpenPrReason),
    item('createPrInBrowser', 'Create Pull Request in Browser', createPrReason),
    item(
      'openRepoInBrowser',
      'Open Repository in Browser',
      firstReason(!state.integrations.remoteWebUrl && 'This repository has no supported remote web URL.'),
    ),
    SEPARATOR,
    item('newBranch', 'New Branch\u2026', firstReason(busy)),
    item('createWorktree', 'New Worktree\u2026', firstReason(busy)),
    item('stashChanges', 'Stash Changes...', firstReason(busy)),
    SEPARATOR,
    item('refresh', 'Refresh'),
  ];
}

export function buildWorktreeMenu(worktree: WorktreeInfo): MenuEntry[] {
  return [
    item(
      'openWorktree',
      'Open in New Window',
      worktree.isCurrent ? 'Already open in this window' : undefined,
    ),
    item('copyWorktreePath', 'Copy Worktree Path'),
    SEPARATOR,
    item(
      'removeWorktree',
      'Remove Worktree…',
      worktree.isMain
        ? 'Cannot remove the main worktree'
        : worktree.isCurrent
          ? 'Cannot remove the currently open worktree'
          : undefined,
    ),
  ];
}

export function buildStashMenu(stash: StashInfo, state: ExplorerUiState): MenuEntry[] {
  const disabled = state.isBusy ? BUSY_REASON : undefined;
  return [
    item('inspectStash', 'Inspect Stash'),
    SEPARATOR,
    item('applyStash', 'Apply Stash', disabled),
    item('popStash', 'Pop Stash', disabled),
    SEPARATOR,
    item('dropStash', 'Drop Stash\u2026', disabled),
  ];
}

export function buildSettingsMenu(options: {
  showCheckedOutBadge: boolean;
  showFolderCounts: boolean;
  trackingOrder: TrackingIndicatorOrder;
}): MenuEntry[] {
  return [
    item('toggleCheckedOutBadge', options.showCheckedOutBadge ? 'Hide "Checked Out" Badge' : 'Show "Checked Out" Badge'),
    item('toggleFolderCounts', options.showFolderCounts ? 'Hide Folder Branch Counts' : 'Show Folder Branch Counts'),
    item(
      'toggleTrackingOrder',
      options.trackingOrder === 'vscode'
        ? 'Commit Counters: Switch to ↑ ↓ (Visual Studio)'
        : 'Commit Counters: Switch to ↓ ↑ (VS Code)',
    ),
  ];
}

/** Right-click menu for a commit row in the history table. */
export function buildCommitMenu(snapshot: RepoSnapshot, state: ExplorerUiState, commit: CommitNode): MenuEntry[] {
  const busy = state.isBusy && BUSY_REASON;
  const noHead = getHeadHash(snapshot) === null && 'No commit is checked out yet.';
  const isMerge = commit.parents.length > 1;
  const hasCurrentBranch = !snapshot.isDetachedHead && snapshot.localBranches.some((branch) => branch.isCurrent);
  const currentLabel = snapshot.isDetachedHead ? 'Current Branch' : snapshot.currentBranch;
  const resetReason = firstReason(
    busy,
    snapshot.isDetachedHead && DETACHED_REASON,
    !hasCurrentBranch && 'No branch is checked out.',
  );

  return [
    item('copyHash', 'Copy Commit Hash'),
    item('createBranchHere', 'Create Branch from Here\u2026', firstReason(busy)),
    gitActionItem('createTag', 'Create Tag\u2026', 'createTag', firstReason(busy)),
    SEPARATOR,
    item(
      'cherryPick',
      'Cherry-Pick',
      firstReason(
        busy,
        noHead,
        isMerge && 'Merge commits cannot be cherry-picked here.',
        !noHead && isAncestorOfHead(snapshot, commit.hash) && 'Already part of the current branch history.',
      ),
    ),
    isMerge
      ? item('revertMerge', 'Revert Merge Commit (Mainline 1)…', firstReason(busy, noHead))
      : item('revert', 'Revert', firstReason(busy, noHead)),
    SEPARATOR,
    item('resetMixed', `Reset ${currentLabel} Here — Keep Changes (--mixed)…`, resetReason),
    item('resetHard', `Reset ${currentLabel} Here — Delete Changes (--hard)…`, resetReason),
    SEPARATOR,
    item('openGitGraph', 'Open in Git Graph', state.integrations.gitGraphAvailable ? undefined : 'The Git Graph extension is not installed.'),
    item(
      'openCommitInBrowser',
      state.integrations.remoteProviderName
        ? `Open Commit on ${state.integrations.remoteProviderName}`
        : 'Open Commit in Browser',
      state.integrations.remoteWebUrl || state.integrations.githubRemoteUrl
        ? undefined
        : 'This repository has no supported remote web URL.',
    ),
  ];
}

/** Keeps a menu of `width` x `height` inside an 8px viewport gutter, preferring the pointer position. */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const left = Math.max(8, Math.min(x, Math.max(8, viewportWidth - width - 8)));
  const top =
    y + height > viewportHeight - 8
      ? Math.max(8, viewportHeight - height - 8)
      : Math.max(8, y);
  return { left, top };
}
