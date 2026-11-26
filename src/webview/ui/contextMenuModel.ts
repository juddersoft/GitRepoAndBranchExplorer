import type { CommitNode, RepoSnapshot } from '../../types/git';
import type { TrackingIndicatorOrder } from '../../types/messages';
import { planTrackedFetch } from '../../git/trackedFetch';
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
  | 'renameBranch'
  | 'untrackBranch'
  | 'publishRepository'
  | 'isolate'
  | 'deleteBranch'
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
  | { kind: 'item'; id: MenuActionId; label: string; enabled: boolean; reason?: string }
  | { kind: 'separator' };

const BUSY_REASON = 'Another Git operation is running.';
const DETACHED_REASON = 'HEAD is detached; check out a branch first.';

function item(id: MenuActionId, label: string, disabledReason?: string): MenuEntry {
  return disabledReason === undefined
    ? { kind: 'item', id, label, enabled: true }
    : { kind: 'item', id, label, enabled: false, reason: disabledReason };
}

const SEPARATOR: MenuEntry = { kind: 'separator' };

/** First reason an action cannot run, in priority order; `undefined` means it is available. */
function firstReason(...reasons: Array<string | false | undefined>): string | undefined {
  return reasons.find((reason): reason is string => typeof reason === 'string');
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
    return [createBranch, SEPARATOR, merge, rebase, SEPARATOR, ...resetEntries];
  }

  const isolate = item(
    'isolate',
    state.pinnedBranchFullNames.has(target.fullName) ? 'Stop Isolating in History' : 'Show Only This Branch in History',
  );

  if (target.kind === 'remote') {
    const remoteWebReason = state.integrations.remoteWebUrl
      ? undefined
      : 'This repository has no supported remote web URL.';
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
      item('createPrInBrowser', 'Create Pull Request in Browser', remoteWebReason),
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
  return [
    item('checkout', 'Check Out', firstReason(busy, isCheckedOut && 'Already checked out.')),
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
      firstReason(busy, !state.integrations.remoteWebUrl && 'This repository has no supported remote web URL.'),
    ),
    item('fetch', 'Fetch', firstReason(busy)),
    SEPARATOR,
    item('createPrInBrowser', 'Create Pull Request in Browser', trackedWebReason),
    item('openBranchInBrowser', 'Open Branch in Browser', trackedWebReason),
    SEPARATOR,
    createBranch,
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
      firstReason(busy, isCheckedOut && 'Cannot delete the checked-out branch.', detached && DETACHED_REASON),
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

  return [
    ...(!hasRemotes
      ? [item('publishRepository', 'Publish Repository / Add Remote\u2026', firstReason(busy)), SEPARATOR]
      : []),
    item('fetchTracked', 'Fetch', firstReason(busy, nothingToFetch && 'No local branch tracks a remote branch.')),
    item('pull', 'Pull', pull),
    item('push', current?.upstream ? 'Push' : 'Publish Branch', push),
    item('pushAndOpenPr', 'Push and Open PR in Browser', webReason),
    item('createPrInBrowser', 'Create Pull Request in Browser', webReason),
    item(
      'openRepoInBrowser',
      'Open Repository in Browser',
      firstReason(!state.integrations.remoteWebUrl && 'This repository has no supported remote web URL.'),
    ),
    SEPARATOR,
    item('newBranch', 'New Branch\u2026', firstReason(busy)),
    SEPARATOR,
    item('refresh', 'Refresh'),
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
