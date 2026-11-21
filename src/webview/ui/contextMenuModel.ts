import type { CommitNode, RepoSnapshot } from '../../types/git';
import type { ExplorerUiState, RefTarget } from './state';
import { getHeadHash, isAncestorOfHead } from './state';

export type MenuActionId =
  | 'checkout'
  | 'checkoutRemote'
  | 'merge'
  | 'rebase'
  | 'pull'
  | 'push'
  | 'fetch'
  | 'createBranchHere'
  | 'isolate'
  | 'deleteBranch'
  | 'cherryPick'
  | 'revert'
  | 'copyHash'
  | 'openGitGraph'
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

  if (target.kind === 'tag') {
    return [createBranch, SEPARATOR, merge, rebase];
  }

  const isolate = item(
    'isolate',
    state.pinnedBranchFullNames.has(target.fullName) ? 'Stop Isolating in History' : 'Show Only This Branch in History',
  );

  if (target.kind === 'remote') {
    return [
      item('checkoutRemote', 'Check Out as Local Tracking Branch\u2026', firstReason(busy)),
      SEPARATOR,
      merge,
      rebase,
      SEPARATOR,
      createBranch,
      isolate,
      SEPARATOR,
      item('fetch', 'Fetch', firstReason(busy)),
    ];
  }

  const branch = target.branch;
  const notCurrent = !isCheckedOut && 'Check out this branch first.';
  const hasUpstream = branch?.upstream != null && branch.upstream !== '';
  return [
    item('checkout', 'Check Out', firstReason(busy, isCheckedOut && 'Already checked out.')),
    SEPARATOR,
    merge,
    rebase,
    SEPARATOR,
    item('pull', 'Pull', firstReason(busy, notCurrent, !hasUpstream && 'No upstream branch is configured.')),
    item('push', hasUpstream ? 'Push' : 'Publish Branch', firstReason(busy, notCurrent)),
    item('fetch', 'Fetch', firstReason(busy)),
    SEPARATOR,
    createBranch,
    isolate,
    SEPARATOR,
    item(
      'deleteBranch',
      'Delete Branch\u2026',
      firstReason(busy, isCheckedOut && 'Cannot delete the checked-out branch.', detached && DETACHED_REASON),
    ),
  ];
}

/** Right-click menu for a commit row in the history table. */
export function buildCommitMenu(snapshot: RepoSnapshot, state: ExplorerUiState, commit: CommitNode): MenuEntry[] {
  const busy = state.isBusy && BUSY_REASON;
  const noHead = getHeadHash(snapshot) === null && 'No commit is checked out yet.';
  const isMerge = commit.parents.length > 1;

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
    item('revert', 'Revert', firstReason(busy, noHead, isMerge && 'Merge commits cannot be reverted here.')),
    SEPARATOR,
    item('openGitGraph', 'Open in Git Graph', state.integrations.gitGraphAvailable ? undefined : 'The Git Graph extension is not installed.'),
    item('openGitHub', 'Open on GitHub', state.integrations.githubRemoteUrl !== null ? undefined : 'This repository has no GitHub remote.'),
  ];
}

/** Keeps a menu of `width` x `height` fully inside the viewport, preferring the pointer position. */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const clamp = (value: number, size: number, limit: number): number => Math.max(0, Math.min(value, limit - size));
  return { left: clamp(x, width, viewportWidth), top: clamp(y, height, viewportHeight) };
}
