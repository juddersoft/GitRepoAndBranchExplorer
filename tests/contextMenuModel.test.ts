import { describe, expect, it } from 'vitest';
import type { BranchInfo, CommitNode, RepoSnapshot } from '../src/types/git';
import { buildCommitMenu, buildRefMenu, buildRepoMenu, clampMenuPosition, pullPushDisabledReason } from '../src/webview/ui/contextMenuModel';
import type { MenuActionId, MenuEntry } from '../src/webview/ui/contextMenuModel';
import type { ExplorerUiState } from '../src/webview/ui/state';
import { branchRefTarget, createInitialState, tagRefTarget } from '../src/webview/ui/state';

const sha = (char: string): string => char.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');
const M = sha('e');

function branch(name: string, tipHash: string, patch: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    displayName: name,
    fullName: `refs/heads/${name}`,
    isCurrent: false,
    isRemote: false,
    remoteName: null,
    tipHash,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    ...patch,
  };
}

function commit(hash: string, parents: string[]): CommitNode {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents,
    subject: hash,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDateIso: '2023-11-14T22:13:20+00:00',
    authorTimestamp: 1700000000,
    refs: [],
  };
}

/*
 *   M                           <- main (checked out, tracks origin/main)
 *   |   D                       <- feature (side branch, not merged)
 *   C --'
 *   B                           <- release (an ancestor of main)
 *   A   root                    <- tag v1
 *   G   merge of D and B        (not reachable from main)
 */
const G = sha('1');
const main = branch('main', M, { isCurrent: true, upstream: 'origin/main' });
const feature = branch('feature', D);
const release = branch('release', B);
const originFeature: BranchInfo = {
  ...branch('origin/feature', D),
  displayName: 'feature',
  fullName: 'refs/remotes/origin/feature',
  isRemote: true,
  remoteName: 'origin',
};

const snapshot: RepoSnapshot = {
  repoName: 'repo',
  repoRoot: '/repo',
  currentBranch: 'main',
  isDetachedHead: false,
  localBranches: [main, feature, release],
  remoteGroups: [{ remoteName: 'origin', branches: [originFeature] }],
  tags: [{ name: 'v1', fullName: 'refs/tags/v1', targetHash: A }],
  commits: [commit(G, [D, B]), commit(M, [C]), commit(D, [C]), commit(C, [B]), commit(B, [A]), commit(A, [])],
  hasMoreCommits: false,
};

const state = (patch: Partial<ExplorerUiState> = {}): ExplorerUiState => ({ ...createInitialState(), snapshot, ...patch });

function item(entries: MenuEntry[], id: MenuActionId): Extract<MenuEntry, { kind: 'item' }> {
  const found = entries.find((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item' && e.id === id);
  if (!found) {
    throw new Error(`No menu item "${id}"`);
  }
  return found;
}

const ids = (entries: MenuEntry[]): string[] => entries.flatMap((e) => (e.kind === 'item' ? [e.id] : []));
const enabled = (entries: MenuEntry[]): string[] => entries.flatMap((e) => (e.kind === 'item' && e.enabled ? [e.id] : []));

describe('buildRefMenu: local branches', () => {
  it('offers the full branch menu', () => {
    expect(ids(buildRefMenu(snapshot, state(), branchRefTarget(feature)))).toEqual([
      'checkout', 'merge', 'rebase', 'resetMixed', 'resetHard',
      'pull', 'push', 'fetch', 'createBranchHere', 'isolate', 'deleteBranch',
    ]);
  });

  it('enables checkout, merge, rebase and delete for another branch, but not pull/push', () => {
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(feature));
    expect(enabled(menu)).toEqual([
      'checkout', 'merge', 'rebase', 'resetMixed', 'resetHard',
      'fetch', 'createBranchHere', 'isolate', 'deleteBranch',
    ]);
    expect(item(menu, 'pull').reason).toMatch(/check out/i);
    expect(item(menu, 'merge').reason).toBeUndefined();
    expect(item(menu, 'merge').label).toBe('Merge into main');
  });

  it('disables checkout, merge, rebase and delete for the checked-out branch', () => {
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(main));
    for (const id of ['checkout', 'merge', 'rebase', 'deleteBranch'] as const) {
      expect(item(menu, id).enabled, id).toBe(false);
    }
    expect(enabled(menu)).toEqual(['resetMixed', 'resetHard', 'pull', 'push', 'fetch', 'createBranchHere', 'isolate']);
  });

  it('disables pull when the checked-out branch has no upstream, and labels push as Publish', () => {
    const noUpstream: RepoSnapshot = { ...snapshot, localBranches: [{ ...main, upstream: null }, feature, release] };
    const menu = buildRefMenu(noUpstream, state({ snapshot: noUpstream }), branchRefTarget({ ...main, upstream: null }));
    expect(item(menu, 'pull')).toMatchObject({ enabled: false, reason: expect.stringMatching(/upstream/i) });
    expect(item(menu, 'push')).toMatchObject({ enabled: true, label: 'Publish Branch' });
  });

  it('disables merge, rebase and delete when HEAD is detached', () => {
    const detached: RepoSnapshot = { ...snapshot, isDetachedHead: true, localBranches: [{ ...main, isCurrent: false }, feature, release] };
    const menu = buildRefMenu(detached, state({ snapshot: detached }), branchRefTarget(feature));
    for (const id of ['merge', 'rebase', 'deleteBranch'] as const) {
      expect(item(menu, id), id).toMatchObject({ enabled: false, reason: expect.stringMatching(/detached/i) });
    }
    expect(item(menu, 'checkout').enabled).toBe(true);
    expect(item(menu, 'resetMixed')).toMatchObject({ enabled: false, reason: expect.stringMatching(/detached/i) });
    expect(item(menu, 'resetHard')).toMatchObject({ enabled: false, reason: expect.stringMatching(/detached/i) });
  });

  it('disables merge for a branch that is already an ancestor of HEAD, but still allows rebase', () => {
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(release));
    expect(item(menu, 'merge')).toMatchObject({ enabled: false, reason: expect.stringMatching(/already/i) });
    expect(item(menu, 'rebase').enabled).toBe(true);
  });

  it('disables every mutation while another operation is running', () => {
    const menu = buildRefMenu(snapshot, state({ isBusy: true }), branchRefTarget(feature));
    expect(enabled(menu)).toEqual(['isolate']);
    expect(item(menu, 'checkout').reason).toMatch(/running/i);
  });

  it('toggles the isolate label with the pin state', () => {
    expect(item(buildRefMenu(snapshot, state(), branchRefTarget(feature)), 'isolate').label).toBe('Show Only This Branch in History');
    const pinned = state({ pinnedBranchFullNames: new Set([feature.fullName]) });
    expect(item(buildRefMenu(snapshot, pinned, branchRefTarget(feature)), 'isolate').label).toBe('Stop Isolating in History');
  });
});

describe('buildRefMenu: remote branches and tags', () => {
  it('offers a tracking checkout, merge and rebase for a remote branch, and never delete/pull/push', () => {
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(originFeature));
    expect(ids(menu)).toEqual([
      'checkoutRemote', 'merge', 'rebase', 'resetMixed', 'resetHard', 'createBranchHere', 'isolate', 'fetch',
    ]);
    expect(enabled(menu)).toEqual(ids(menu));
  });

  it('disables merge/rebase for a remote branch when HEAD is detached', () => {
    const detached: RepoSnapshot = { ...snapshot, isDetachedHead: true };
    const menu = buildRefMenu(detached, state({ snapshot: detached }), branchRefTarget(originFeature));
    expect(item(menu, 'merge').enabled).toBe(false);
    expect(item(menu, 'rebase').enabled).toBe(false);
    expect(item(menu, 'checkoutRemote').enabled).toBe(true);
    expect(item(menu, 'resetMixed').enabled).toBe(false);
    expect(item(menu, 'resetHard').enabled).toBe(false);
  });

  it('offers branch creation, merge and rebase for a tag', () => {
    const menu = buildRefMenu(snapshot, state(), tagRefTarget(snapshot.tags[0]));
    expect(ids(menu)).toEqual(['createBranchHere', 'merge', 'rebase', 'resetMixed', 'resetHard']);
    // The tag sits on HEAD's ancestry, so merging it would be a no-op.
    expect(item(menu, 'merge')).toMatchObject({ enabled: false, reason: expect.stringMatching(/already/i) });
    expect(item(menu, 'rebase').enabled).toBe(true);
    expect(item(menu, 'resetMixed').enabled).toBe(true);
    expect(item(menu, 'resetHard').enabled).toBe(true);
  });
});

describe('buildCommitMenu', () => {
  const find = (hash: string): CommitNode => snapshot.commits.find((c) => c.hash === hash) as CommitNode;

  it('enables cherry-pick for a commit outside HEAD history', () => {
    const detachedSide: RepoSnapshot = {
      ...snapshot,
      commits: [commit(sha('f'), [A]), ...snapshot.commits],
    };
    const menu = buildCommitMenu(detachedSide, state({ snapshot: detachedSide }), detachedSide.commits[0]);
    expect(item(menu, 'cherryPick').enabled).toBe(true);
    expect(item(menu, 'revert').enabled).toBe(true);
  });

  it('disables cherry-pick for commits already reachable from HEAD, including HEAD itself', () => {
    for (const hash of [M, C, A]) {
      expect(item(buildCommitMenu(snapshot, state(), find(hash)), 'cherryPick'), hash).toMatchObject({
        enabled: false,
        reason: expect.stringMatching(/already/i),
      });
    }
  });

  it('offers enabled mainline-1 merge revert for merge commits', () => {
    const menu = buildCommitMenu(snapshot, state(), find(G));
    expect(item(menu, 'cherryPick')).toMatchObject({ enabled: false, reason: expect.stringMatching(/merge/i) });
    expect(item(menu, 'revertMerge')).toMatchObject({ enabled: true, label: 'Revert Merge Commit (Mainline 1)…' });
    expect(ids(menu)).not.toContain('revert');
  });

  it('disables cherry-pick and revert before the first commit exists', () => {
    const unborn: RepoSnapshot = { ...snapshot, localBranches: [], commits: [commit(A, [])] };
    const menu = buildCommitMenu(unborn, state({ snapshot: unborn }), unborn.commits[0]);
    expect(item(menu, 'cherryPick').enabled).toBe(false);
    expect(item(menu, 'revert').enabled).toBe(false);
    expect(item(menu, 'resetMixed').enabled).toBe(false);
    expect(item(menu, 'resetHard').enabled).toBe(false);
  });

  it('offers both reset modes with branch labels and blocks them on detached HEAD', () => {
    const menu = buildCommitMenu(snapshot, state(), find(C));
    expect(item(menu, 'resetMixed')).toMatchObject({ enabled: true, label: 'Reset main Here — Keep Changes (--mixed)…' });
    expect(item(menu, 'resetHard')).toMatchObject({ enabled: true, label: 'Reset main Here — Delete Changes (--hard)…' });

    const detached: RepoSnapshot = { ...snapshot, isDetachedHead: true };
    const detachedMenu = buildCommitMenu(detached, state({ snapshot: detached }), find(C));
    expect(item(detachedMenu, 'resetMixed').enabled).toBe(false);
    expect(item(detachedMenu, 'resetHard').enabled).toBe(false);
  });

  it('gates the integrations on what is available', () => {
    const none = buildCommitMenu(snapshot, state(), find(C));
    expect(item(none, 'openGitGraph').enabled).toBe(false);
    expect(item(none, 'openGitHub').enabled).toBe(false);
    const both = buildCommitMenu(
      snapshot,
      state({ integrations: { gitGraphAvailable: true, gitGraphExtensionId: 'x.y', githubRemoteUrl: 'https://github.com/o/r' } }),
      find(C),
    );
    expect(item(both, 'openGitGraph').enabled).toBe(true);
    expect(item(both, 'openGitHub').enabled).toBe(true);
  });

  it('always allows copying the hash and disables mutations while busy', () => {
    const menu = buildCommitMenu(snapshot, state({ isBusy: true }), find(B));
    expect(item(menu, 'copyHash').enabled).toBe(true);
    expect(item(menu, 'createBranchHere').enabled).toBe(false);
    expect(item(menu, 'revert').enabled).toBe(false);
  });
});

describe('buildRepoMenu', () => {
  const withBranches = (localBranches: BranchInfo[], patch: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
    ...snapshot,
    localBranches,
    ...patch,
  });
  const menuFor = (
    snap: RepoSnapshot,
    patch: Partial<ExplorerUiState> = {},
    showCheckedOutBadge?: boolean,
    showFolderCounts?: boolean,
    trackingOrder?: ExplorerUiState['trackingOrder'],
  ): MenuEntry[] => buildRepoMenu(
    snap,
    state({ snapshot: snap, ...patch }),
    showCheckedOutBadge,
    showFolderCounts,
    trackingOrder,
  );

  it('offers Fetch, Pull, Push, New Branch, preference toggles and Refresh', () => {
    const menu = menuFor(snapshot);
    expect(ids(menu)).toEqual([
      'fetchTracked', 'pull', 'push', 'newBranch', 'toggleCheckedOutBadge', 'toggleFolderCounts',
      'toggleTrackingOrder', 'refresh',
    ]);
    expect(enabled(menu)).toEqual(ids(menu));
    expect(item(menu, 'push').label).toBe('Push');
  });

  it('labels the badge toggle by the current preference and never disables it', () => {
    expect(item(menuFor(snapshot, {}, true), 'toggleCheckedOutBadge')).toMatchObject({ label: 'Hide "Checked Out" Badge', enabled: true });
    expect(item(menuFor(snapshot), 'toggleCheckedOutBadge').label).toBe('Hide "Checked Out" Badge');
    expect(item(menuFor(snapshot, { isBusy: true }, false), 'toggleCheckedOutBadge')).toMatchObject({
      label: 'Show "Checked Out" Badge',
      enabled: true,
    });
  });

  it('labels the folder count toggle by the current preference', () => {
    expect(item(menuFor(snapshot), 'toggleFolderCounts')).toMatchObject({
      label: 'Hide Folder Branch Counts',
      enabled: true,
    });
    expect(item(menuFor(snapshot, { isBusy: true }, true, false), 'toggleFolderCounts')).toMatchObject({
      label: 'Show Folder Branch Counts',
      enabled: true,
    });
  });

  it('labels the tracking order toggle for VS Code by default and Visual Studio when selected', () => {
    expect(item(menuFor(snapshot), 'toggleTrackingOrder')).toMatchObject({
      label: 'Commit Counters: Switch to ↑ ↓ (Visual Studio)',
      enabled: true,
    });
    expect(item(menuFor(snapshot, {}, true, true, 'visualStudio'), 'toggleTrackingOrder')).toMatchObject({
      label: 'Commit Counters: Switch to ↓ ↑ (VS Code)',
      enabled: true,
    });
    expect(item(menuFor(snapshot, { isBusy: true }, true, true, 'visualStudio'), 'toggleTrackingOrder').enabled).toBe(true);
  });

  it('disables Fetch when no local branch tracks a remote, but keeps pull/push rules independent', () => {
    const menu = menuFor(withBranches([{ ...main, upstream: null }, feature, release]));
    expect(item(menu, 'fetchTracked')).toMatchObject({ enabled: false, reason: expect.stringMatching(/tracks a remote/i) });
    expect(item(menu, 'pull')).toMatchObject({ enabled: false, reason: expect.stringMatching(/upstream/i) });
    expect(item(menu, 'push')).toMatchObject({ enabled: true, label: 'Publish Branch' });
  });

  it('keeps Fetch enabled when only a non-checked-out branch tracks a remote', () => {
    const menu = menuFor(withBranches([{ ...main, upstream: null }, branch('feature', D, { upstream: 'origin/feature' })]));
    expect(item(menu, 'fetchTracked').enabled).toBe(true);
  });

  it('does not count a branch whose upstream remote is unknown as fetchable', () => {
    const menu = menuFor(withBranches([{ ...main, upstream: 'gone-remote/main' }]));
    expect(item(menu, 'fetchTracked').enabled).toBe(false);
  });

  it('disables Pull and Push on a detached HEAD', () => {
    const menu = menuFor(withBranches([{ ...main, isCurrent: false }, feature], { isDetachedHead: true }));
    expect(item(menu, 'pull')).toMatchObject({ enabled: false, reason: expect.stringMatching(/detached/i) });
    expect(item(menu, 'push')).toMatchObject({ enabled: false, reason: expect.stringMatching(/detached/i) });
    expect(item(menu, 'fetchTracked').enabled).toBe(true);
  });

  it('disables Pull and Push before the first commit exists', () => {
    const menu = menuFor(withBranches([]));
    expect(item(menu, 'pull')).toMatchObject({ enabled: false, reason: expect.stringMatching(/no branch/i) });
    expect(item(menu, 'push').enabled).toBe(false);
  });

  it('disables Pull when the upstream of the checked-out branch is gone', () => {
    const menu = menuFor(withBranches([{ ...main, upstreamGone: true }, feature]));
    expect(item(menu, 'pull')).toMatchObject({ enabled: false, reason: expect.stringMatching(/no longer exists/i) });
    expect(item(menu, 'push').enabled).toBe(true);
  });

  it('disables Fetch, Pull, Push and New Branch while busy, but still allows the badge toggle and Refresh', () => {
    const menu = menuFor(snapshot, { isBusy: true });
    expect(enabled(menu)).toEqual(['toggleCheckedOutBadge', 'toggleFolderCounts', 'toggleTrackingOrder', 'refresh']);
    expect(item(menu, 'fetchTracked').reason).toMatch(/running/i);
  });
});

describe('pullPushDisabledReason', () => {
  it('blocks pull without an upstream and both actions on a detached HEAD', () => {
    expect(pullPushDisabledReason('pull', false, 'origin/main')).toBeUndefined();
    expect(pullPushDisabledReason('pull', false, null)).toMatch(/upstream/i);
    expect(pullPushDisabledReason('pull', false, '')).toMatch(/upstream/i);
    expect(pullPushDisabledReason('push', false, null)).toBeUndefined();
    expect(pullPushDisabledReason('push', true, 'origin/main')).toMatch(/detached/i);
    expect(pullPushDisabledReason('pull', true, 'origin/main')).toMatch(/detached/i);
  });
});

describe('clampMenuPosition', () => {
  it('keeps the pointer position when the menu fits', () => {
    expect(clampMenuPosition(10, 20, 200, 100, 800, 600)).toEqual({ left: 10, top: 20 });
  });

  it('shifts the menu back inside the viewport', () => {
    expect(clampMenuPosition(750, 580, 200, 100, 800, 600)).toEqual({ left: 600, top: 500 });
  });

  it('never goes negative, even when the menu is larger than the viewport', () => {
    expect(clampMenuPosition(5, 5, 900, 700, 800, 600)).toEqual({ left: 0, top: 0 });
  });
});
