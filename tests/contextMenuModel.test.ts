import { describe, expect, it } from 'vitest';
import type { BranchInfo, CommitNode, FileHistoryCommit, RepoSnapshot } from '../src/types/git';
import { buildCommitMenu, buildFileHistoryCommitMenu, buildRefMenu, buildRepoMenu, buildSettingsMenu, buildStashMenu, buildWorktreeMenu, clampMenuPosition, pullPushDisabledReason } from '../src/webview/ui/contextMenuModel';
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
  worktrees: [],
  stashes: [],
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

describe('buildFileHistoryCommitMenu', () => {
  const fileCommit = (char: string, timestamp: number): FileHistoryCommit => ({
    hash: sha(char),
    shortHash: sha(char).slice(0, 8),
    parents: [],
    subject: char,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDateIso: '2026-11-10T12:00:00Z',
    authorTimestamp: timestamp,
    refs: [],
    filePathAtCommit: 'src/file.ts',
  });

  it('places compare-selected first only for a selected right-clicked commit pair', () => {
    const older = fileCommit('a', 100);
    const newer = fileCommit('b', 200);
    const historyState = state({
      fileHistory: { kind: 'file', repoRoot: '/repo', filePath: 'src/file.ts', commits: [newer, older], hasMore: false },
      selectedComparisonHashes: [older.hash, newer.hash],
    });
    expect(ids(buildFileHistoryCommitMenu(historyState, newer))[0]).toBe('compareSelectedRevisions');
    expect(ids(buildFileHistoryCommitMenu(historyState, fileCommit('c', 300))))
      .not.toContain('compareSelectedRevisions');
  });

  it('includes standard actions and conditionally includes open-in-browser', () => {
    const commit = fileCommit('a', 100);
    const noRemote = state({ fileHistory: { kind: 'file', repoRoot: '/repo', filePath: 'src/file.ts', commits: [commit], hasMore: false } });
    expect(ids(buildFileHistoryCommitMenu(noRemote, commit))).toEqual([
      'compareWithWorkingTree',
      'openFileAtRevision',
      'copyHash',
    ]);
    const withRemote = state({
      integrations: { ...noRemote.integrations, remoteWebUrl: 'https://github.com/acme/repo' },
      fileHistory: noRemote.fileHistory,
    });
    expect(ids(buildFileHistoryCommitMenu(withRemote, commit))).toContain('openCommitInBrowser');
  });

  it('does not show compare-selected for invalid or one-sided selections', () => {
    const commit = fileCommit('a', 100);
    const onlyOne = state({
      fileHistory: { kind: 'file', repoRoot: '/repo', filePath: 'src/file.ts', commits: [commit], hasMore: false },
      selectedComparisonHashes: [commit.hash],
    });
    expect(ids(buildFileHistoryCommitMenu(onlyOne, commit))).not.toContain('compareSelectedRevisions');
  });
});

describe('buildRefMenu: local branches', () => {
  it('guards compareWithCurrent and allows compareWithOther for ref types and busy/empty states', () => {
    expect(item(buildRefMenu(snapshot, state(), branchRefTarget(main)), 'compareWithCurrent')).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/checked-out/i),
    });
    expect(item(buildRefMenu(snapshot, state(), branchRefTarget(feature)), 'compareWithCurrent').enabled).toBe(true);
    expect(item(buildRefMenu(snapshot, state({ isBusy: true }), branchRefTarget(feature)), 'compareWithCurrent').enabled).toBe(false);
    expect(item(buildRefMenu({ ...snapshot, commits: [] }, state({ snapshot: { ...snapshot, commits: [] } }), branchRefTarget(feature)), 'compareWithCurrent').enabled).toBe(false);
    expect(item(buildRefMenu(snapshot, state(), branchRefTarget(feature)), 'compareWithOther').enabled).toBe(true);
  });

  it('disables Create PR for a local branch tracking the remote default branch', () => {
    const withDefaultMain: RepoSnapshot = {
      ...snapshot,
      remoteGroups: [{ remoteName: 'origin', branches: [originFeature], defaultBranch: 'main' }],
    };
    const integration = state({
      snapshot: withDefaultMain,
      integrations: {
        gitGraphAvailable: false,
        gitGraphExtensionId: null,
        githubRemoteUrl: 'https://github.com/o/r',
        remoteWebUrl: 'https://github.com/o/r',
        remoteProvider: 'github',
        remoteProviderName: 'GitHub',
      },
    });
    expect(item(buildRefMenu(withDefaultMain, integration, branchRefTarget(main)), 'createPrInBrowser'))
      .toMatchObject({
        enabled: false,
        reason: 'Cannot create a pull request from the default branch (main).',
      });

    const featureWithUpstream = { ...feature, upstream: 'origin/feature/foo' };
    const menu = buildRefMenu(withDefaultMain, integration, branchRefTarget(featureWithUpstream));
    expect(item(menu, 'createPrInBrowser').enabled).toBe(true);
  });

  it('offers the full branch menu', () => {
    expect(ids(buildRefMenu(snapshot, state(), branchRefTarget(feature)))).toEqual([
      'checkout', 'merge', 'rebase', 'compareWithCurrent', 'compareWithOther', 'resetMixed', 'resetHard',
      'pull', 'push', 'pushAndOpenPr', 'fetch', 'createPrInBrowser', 'openBranchInBrowser',
      'createBranchHere', 'createWorktree', 'stashChanges', 'renameBranch', 'untrackBranch', 'isolate', 'deleteBranch',
    ]);
  });

  it('guards Push and Open PR on the default branch but enables it for a feature branch', () => {
    const defaultSnapshot: RepoSnapshot = {
     ...snapshot,
     remoteGroups: [{ remoteName: 'origin', branches: [originFeature], defaultBranch: 'main' }],
    };
    const integrations = {
     gitGraphAvailable: false,
     gitGraphExtensionId: null,
     githubRemoteUrl: 'https://github.com/o/r',
     remoteWebUrl: 'https://github.com/o/r',
     remoteProvider: 'github' as const,
     remoteProviderName: 'GitHub',
    };
    expect(item(
     buildRefMenu(defaultSnapshot, state({ snapshot: defaultSnapshot, integrations }), branchRefTarget(main)),
     'pushAndOpenPr',
    )).toMatchObject({
     enabled: false,
     reason: 'Cannot create a pull request from the default branch (main).',
    });

    const trackedFeature = { ...feature, upstream: 'origin/feature' };
    const featureMenu = buildRefMenu(
     { ...defaultSnapshot, localBranches: [main, trackedFeature, release] },
     state({ snapshot: defaultSnapshot, integrations }),
     branchRefTarget(trackedFeature),
    );
    expect(item(featureMenu, 'pushAndOpenPr').enabled).toBe(true);
  });

  it('only enables Stash Changes on the checked-out local branch', () => {
    const currentMenu = buildRefMenu(snapshot, state(), branchRefTarget(main));
    expect(item(currentMenu, 'stashChanges')).toMatchObject({ enabled: true, label: 'Stash Changes...' });
    expect(item(buildRefMenu(snapshot, state(), branchRefTarget(feature)), 'stashChanges')).toMatchObject({
     enabled: false,
     reason: 'Only available on the checked-out branch.',
    });
    expect(item(buildRefMenu(snapshot, state({ isBusy: true }), branchRefTarget(main)), 'stashChanges').reason)
     .toMatch(/running/i);
  });

  it('enables checkout, merge, rebase and delete for another branch, but not pull/push', () => {
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(feature));
    expect(enabled(menu)).toEqual([
      'checkout', 'merge', 'rebase', 'compareWithCurrent', 'compareWithOther', 'resetMixed', 'resetHard',
      'push', 'fetch', 'createBranchHere', 'createWorktree', 'renameBranch', 'isolate', 'deleteBranch',
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
    expect(enabled(menu)).toEqual([
      'compareWithOther', 'resetMixed', 'resetHard', 'pull', 'push', 'fetch', 'createBranchHere',
      'stashChanges', 'renameBranch', 'untrackBranch', 'isolate',
    ]);
  });

  it('enables untracking tracked and gone upstreams, and disables it for untracked branches', () => {
    const tracked = buildRefMenu(snapshot, state(), branchRefTarget(main));
    const gone = buildRefMenu(
      { ...snapshot, localBranches: [{ ...main, upstreamGone: true }] },
      state({ snapshot: { ...snapshot, localBranches: [{ ...main, upstreamGone: true }] } }),
      branchRefTarget({ ...main, upstreamGone: true }),
    );
    const untracked = buildRefMenu(snapshot, state(), branchRefTarget(feature));
    expect(item(tracked, 'untrackBranch').enabled).toBe(true);
    expect(item(gone, 'untrackBranch').enabled).toBe(true);
    expect(item(untracked, 'untrackBranch')).toMatchObject({
      enabled: false,
      reason: 'Branch is not tracking a remote branch.',
    });
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

  it('guards branches checked out in another worktree and links to that worktree', () => {
    const linked = { ...feature, worktreePath: '/worktrees/feature' };
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(linked));
    expect(item(menu, 'checkout').reason).toBe('Checked out in another worktree');
    expect(item(menu, 'deleteBranch').reason).toBe('Cannot delete a branch checked out in a worktree');
    expect(item(menu, 'openWorktree')).toMatchObject({ enabled: true, label: 'Open Worktree in New Window' });
    expect(ids(menu)).not.toContain('createWorktree');
  });

  it('builds guarded worktree menus for main, current and linked worktrees', () => {
    const mainWorktree = {
      path: '/repo', headHash: M, branchName: 'main', isDetached: false, isBare: false,
      isMain: true, isCurrent: true, isLocked: false, isPrunable: false,
    };
    expect(item(buildWorktreeMenu(mainWorktree), 'openWorktree').reason).toBe('Already open in this window');
    expect(item(buildWorktreeMenu(mainWorktree), 'removeWorktree').reason).toBe('Cannot remove the main worktree');
    expect(item(buildWorktreeMenu({ ...mainWorktree, isMain: false, isCurrent: false, path: '/feature' }), 'removeWorktree').enabled).toBe(true);
  });

  it('builds apply, pop and drop stash actions with busy guards', () => {
    const stash = { index: 0, ref: 'stash@{0}', hash: A, message: 'saved work', timestamp: 1700000000 };
    expect(ids(buildStashMenu(stash, state()))).toEqual(['inspectStash', 'applyStash', 'popStash', 'dropStash']);
    expect(enabled(buildStashMenu(stash, state()))).toEqual(['inspectStash', 'applyStash', 'popStash', 'dropStash']);
    const busy = buildStashMenu(stash, state({ isBusy: true }));
    expect(enabled(busy)).toEqual(['inspectStash']);
    expect(item(busy, 'dropStash').reason).toMatch(/running/i);
  });
});

describe('buildRefMenu: remote branches and tags', () => {
  it('enables both comparison actions for remote branches and tags', () => {
    for (const target of [originFeature]) {
      const menu = buildRefMenu(snapshot, state(), branchRefTarget(target));
      expect(item(menu, 'compareWithCurrent').enabled).toBe(true);
      expect(item(menu, 'compareWithOther').enabled).toBe(true);
    }
    const tagMenu = buildRefMenu(snapshot, state(), tagRefTarget(snapshot.tags[0]));
    expect(item(tagMenu, 'compareWithCurrent').enabled).toBe(true);
    expect(item(tagMenu, 'compareWithOther').enabled).toBe(true);
  });

  it('disables Create PR for a remote default branch and enables feature branches', () => {
    const remoteMain: BranchInfo = {
      ...originFeature,
      name: 'origin/main',
      displayName: 'main',
      fullName: 'refs/remotes/origin/main',
    };
    const withOriginDefault: RepoSnapshot = {
      ...snapshot,
      remoteGroups: [{ remoteName: 'origin', branches: [remoteMain, originFeature], defaultBranch: 'main' }],
    };
    const integration = state({
      snapshot: withOriginDefault,
      integrations: {
        gitGraphAvailable: false,
        gitGraphExtensionId: null,
        githubRemoteUrl: 'https://github.com/o/r',
        remoteWebUrl: 'https://github.com/o/r',
        remoteProvider: 'github',
        remoteProviderName: 'GitHub',
      },
    });

    expect(item(buildRefMenu(withOriginDefault, integration, branchRefTarget(remoteMain)), 'createPrInBrowser'))
      .toMatchObject({
        enabled: false,
        reason: 'Cannot create a pull request from the default branch (main).',
      });
    expect(item(buildRefMenu(withOriginDefault, integration, branchRefTarget(originFeature)), 'createPrInBrowser'))
      .toMatchObject({ enabled: true });
  });

  it('offers a tracking checkout, merge and rebase for a remote branch, and never delete/pull/push', () => {
    const menu = buildRefMenu(snapshot, state(), branchRefTarget(originFeature));
    expect(ids(menu)).toEqual([
      'checkoutRemote', 'merge', 'rebase', 'compareWithCurrent', 'compareWithOther', 'resetMixed', 'resetHard', 'createBranchHere', 'isolate', 'fetch',
      'createPrInBrowser', 'openBranchInBrowser',
    ]);
    expect(enabled(menu)).toEqual([
      'checkoutRemote', 'merge', 'rebase', 'compareWithCurrent', 'compareWithOther', 'resetMixed', 'resetHard', 'createBranchHere', 'isolate', 'fetch',
    ]);
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
    expect(ids(menu)).toEqual([
      'createBranchHere', 'pushTag', 'merge', 'rebase', 'compareWithCurrent', 'compareWithOther', 'resetMixed', 'resetHard', 'deleteTag',
    ]);
    expect(item(menu, 'pushTag').enabled).toBe(true);
    expect(item(menu, 'deleteTag').danger).toBe(true);
    // The tag sits on HEAD's ancestry, so merging it would be a no-op.
    expect(item(menu, 'merge')).toMatchObject({ enabled: false, reason: expect.stringMatching(/already/i) });
    expect(item(menu, 'rebase').enabled).toBe(true);
    expect(item(menu, 'resetMixed').enabled).toBe(true);
    expect(item(menu, 'resetHard').enabled).toBe(true);
  });

  it('disables tag push without remotes while keeping local deletion available', () => {
    const noRemotes = { ...snapshot, remotes: [], remoteGroups: [] };
    const menu = buildRefMenu(noRemotes, state({ snapshot: noRemotes }), tagRefTarget(noRemotes.tags[0]));
    expect(item(menu, 'pushTag')).toMatchObject({
      enabled: false,
      reason: 'No remotes configured.',
    });
    expect(item(menu, 'deleteTag').enabled).toBe(true);
  });
});

describe('buildCommitMenu', () => {
  it('includes compareWithCurrent and compareWithOther for commits', () => {
    const menu = buildCommitMenu(snapshot, state(), find(C));
    expect(item(menu, 'compareWithCurrent').enabled).toBe(true);
    expect(item(menu, 'compareWithOther').enabled).toBe(true);
  });

  const find = (hash: string): CommitNode => snapshot.commits.find((c) => c.hash === hash) as CommitNode;
  const worktree = (
    path: string,
    patch: Partial<RepoSnapshot['worktrees'][number]> = {},
  ): RepoSnapshot['worktrees'][number] => ({
    path,
    headHash: M,
    branchName: 'feature',
    isDetached: false,
    isBare: false,
    isMain: false,
    isCurrent: false,
    isLocked: false,
    isPrunable: false,
    ...patch,
  });

  it('only shows cherryPickIntoWorktree for snapshots with more than one worktree and places it after cherryPick', () => {
    expect(ids(buildCommitMenu(snapshot, state(), find(C)))).not.toContain('cherryPickIntoWorktree');

    const withWorktrees: RepoSnapshot = {
      ...snapshot,
      worktrees: [
        worktree('/repo', { branchName: 'main', isMain: true, isCurrent: true }),
        worktree('/repo-feature'),
      ],
    };
    const menu = buildCommitMenu(withWorktrees, state({ snapshot: withWorktrees }), find(C));
    const menuIds = ids(menu);
    expect(menuIds).toContain('cherryPickIntoWorktree');
    expect(menuIds.indexOf('cherryPickIntoWorktree')).toBe(menuIds.indexOf('cherryPick') + 1);
  });

  it('keeps cherryPickIntoWorktree enabled for a commit already in current HEAD history', () => {
    const withWorktrees: RepoSnapshot = {
      ...snapshot,
      worktrees: [
        worktree('/repo', { branchName: 'main', isMain: true, isCurrent: true }),
        worktree('/repo-feature'),
      ],
    };
    const menu = buildCommitMenu(withWorktrees, state({ snapshot: withWorktrees }), find(C));
    expect(item(menu, 'cherryPick').enabled).toBe(false);
    expect(item(menu, 'cherryPickIntoWorktree')).toMatchObject({ enabled: true });
  });

  it('disables cherryPickIntoWorktree while busy or for a merge commit', () => {
    const withWorktrees: RepoSnapshot = {
      ...snapshot,
      worktrees: [
        worktree('/repo', { branchName: 'main', isMain: true, isCurrent: true }),
        worktree('/repo-feature'),
      ],
    };
    expect(item(buildCommitMenu(withWorktrees, state({ snapshot: withWorktrees, isBusy: true }), find(C)), 'cherryPickIntoWorktree'))
      .toMatchObject({ enabled: false, reason: expect.stringMatching(/operation/i) });
    expect(item(buildCommitMenu(withWorktrees, state({ snapshot: withWorktrees }), find(G)), 'cherryPickIntoWorktree'))
      .toMatchObject({ enabled: false, reason: expect.stringMatching(/merge/i) });
  });

  it('disables cherryPickIntoWorktree when every other worktree is ineligible', () => {
    for (const patch of [
      { isLocked: true },
      { isPrunable: true },
      { isBare: true },
    ]) {
      const withWorktrees: RepoSnapshot = {
        ...snapshot,
        worktrees: [
          worktree('/repo', { branchName: 'main', isMain: true, isCurrent: true }),
          worktree('/repo-feature', patch),
        ],
      };
      expect(item(buildCommitMenu(withWorktrees, state({ snapshot: withWorktrees }), find(C)), 'cherryPickIntoWorktree'))
        .toMatchObject({ enabled: false, reason: expect.stringMatching(/no other/i) });
    }
  });

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
    expect(item(none, 'openCommitInBrowser').enabled).toBe(false);
    const both = buildCommitMenu(
      snapshot,
      state({
        integrations: {
          gitGraphAvailable: true,
          gitGraphExtensionId: 'x.y',
          githubRemoteUrl: 'https://github.com/o/r',
          remoteWebUrl: 'https://github.com/o/r',
          remoteProvider: 'github',
          remoteProviderName: 'GitHub',
        },
      }),
      find(C),
    );
    expect(item(both, 'openGitGraph').enabled).toBe(true);
    expect(item(both, 'openCommitInBrowser').enabled).toBe(true);
  });

  it('always allows copying the hash and disables mutations while busy', () => {
    const menu = buildCommitMenu(snapshot, state({ isBusy: true }), find(B));
    expect(ids(menu).slice(0, 3)).toEqual(['copyHash', 'createBranchHere', 'createTag']);
    expect(item(menu, 'copyHash').enabled).toBe(true);
    expect(item(menu, 'createBranchHere').enabled).toBe(false);
    expect(item(menu, 'createTag').enabled).toBe(false);
    expect(item(menu, 'revert').enabled).toBe(false);
  });

  it('only offers amend for HEAD, disables it when detached or busy, and always offers create patch', () => {
    const headMenu = buildCommitMenu(snapshot, state(), find(M));
    expect(ids(headMenu)).toContain('amendCommit');
    expect(item(headMenu, 'amendCommit').enabled).toBe(true);
    expect(ids(headMenu)).toContain('createPatch');
    expect(item(headMenu, 'createPatch').enabled).toBe(true);

    const nonHeadMenu = buildCommitMenu(snapshot, state(), find(B));
    expect(ids(nonHeadMenu)).not.toContain('amendCommit');
    expect(ids(nonHeadMenu)).toContain('createPatch');

    const detached: RepoSnapshot = {
      ...snapshot,
      isDetachedHead: true,
      localBranches: snapshot.localBranches.map((b) => ({ ...b, isCurrent: false })),
      commits: snapshot.commits.map((c) => c.hash === M
        ? { ...c, refs: [{ kind: 'head', label: 'HEAD' }] }
        : c),
    };
    const detachedMenu = buildCommitMenu(detached, state({ snapshot: detached }), find(M));
    expect(item(detachedMenu, 'amendCommit')).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/detached/i),
    });

    const busyMenu = buildCommitMenu(snapshot, state({ isBusy: true }), find(M));
    expect(item(busyMenu, 'amendCommit')).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/running/i),
    });
    expect(item(busyMenu, 'createPatch')).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/running/i),
    });
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
  ): MenuEntry[] => buildRepoMenu(
    snap,
    state({ snapshot: snap, ...patch }),
  );

  it('offers Publish Repository for a local-only repository', () => {
    const menu = buildRepoMenu(snapshot, state(), false);
    expect(item(menu, 'publishRepository')).toMatchObject({
      enabled: true,
      label: 'Publish Repository / Add Remote…',
    });
  });

  it('offers only repository-scoped actions', () => {
    const menu = menuFor(snapshot);
    expect(ids(menu)).toEqual([
      'fetchTracked', 'pull', 'push', 'pushAndOpenPr', 'createPrInBrowser', 'openRepoInBrowser',
      'newBranch', 'createWorktree', 'stashChanges', 'applyPatch', 'refresh',
    ]);
    expect(enabled(menu)).toEqual([
      'fetchTracked', 'pull', 'push', 'newBranch', 'createWorktree', 'stashChanges', 'applyPatch', 'refresh',
    ]);
    expect(ids(menu).indexOf('applyPatch')).toBe(ids(menu).indexOf('stashChanges') + 1);
    expect(item(menu, 'push').label).toBe('Push');
    expect(item(menu, 'stashChanges').label).toBe('Stash Changes...');
  });

  it('disables Stash Changes while another operation is running', () => {
    expect(item(menuFor(snapshot, { isBusy: true }), 'stashChanges').reason).toMatch(/running/i);
  });

  it('disables Create PR when the checked-out branch tracks the remote default branch', () => {
    const defaultSnapshot: RepoSnapshot = {
      ...snapshot,
      remoteGroups: [{ remoteName: 'origin', branches: [originFeature], defaultBranch: 'main' }],
    };
    const menu = buildRepoMenu(
      defaultSnapshot,
      state({
        snapshot: defaultSnapshot,
        integrations: {
          gitGraphAvailable: false,
          gitGraphExtensionId: null,
          githubRemoteUrl: 'https://github.com/o/r',
          remoteWebUrl: 'https://github.com/o/r',
          remoteProvider: 'github',
          remoteProviderName: 'GitHub',
        },
      }),
    );
    expect(item(menu, 'createPrInBrowser')).toMatchObject({
      enabled: false,
      reason: 'Cannot create a pull request from the default branch (main).',
    });
    expect(item(menu, 'pushAndOpenPr')).toMatchObject({
      enabled: false,
      reason: 'Cannot create a pull request from the default branch (main).',
    });
  });

  it('keeps display preferences exclusively in the settings menu', () => {
    const settings = buildSettingsMenu({
      showCheckedOutBadge: true,
      showFolderCounts: true,
      trackingOrder: 'vscode',
    });
    expect(ids(settings)).toEqual([
      'toggleCheckedOutBadge',
      'toggleFolderCounts',
      'toggleTrackingOrder',
    ]);
    const repoIds = ids(menuFor(snapshot));
    expect(repoIds).not.toContain('toggleCheckedOutBadge');
    expect(repoIds).not.toContain('toggleFolderCounts');
    expect(repoIds).not.toContain('toggleTrackingOrder');
  });

  it('labels the badge toggle by the current preference and never disables it', () => {
    expect(item(buildSettingsMenu({ showCheckedOutBadge: true, showFolderCounts: true, trackingOrder: 'vscode' }), 'toggleCheckedOutBadge')).toMatchObject({ label: 'Hide "Checked Out" Badge', enabled: true });
    expect(item(buildSettingsMenu({ showCheckedOutBadge: false, showFolderCounts: true, trackingOrder: 'vscode' }), 'toggleCheckedOutBadge')).toMatchObject({
      label: 'Show "Checked Out" Badge',
      enabled: true,
    });
  });

  it('labels the folder count toggle by the current preference', () => {
    expect(item(buildSettingsMenu({ showCheckedOutBadge: true, showFolderCounts: true, trackingOrder: 'vscode' }), 'toggleFolderCounts')).toMatchObject({
      label: 'Hide Folder Branch Counts',
      enabled: true,
    });
    expect(item(buildSettingsMenu({ showCheckedOutBadge: true, showFolderCounts: false, trackingOrder: 'vscode' }), 'toggleFolderCounts')).toMatchObject({
      label: 'Show Folder Branch Counts',
      enabled: true,
    });
  });

  it('labels the tracking order toggle for VS Code by default and Visual Studio when selected', () => {
    expect(item(buildSettingsMenu({ showCheckedOutBadge: true, showFolderCounts: true, trackingOrder: 'vscode' }), 'toggleTrackingOrder')).toMatchObject({
      label: 'Commit Counters: Switch to ↑ ↓ (Visual Studio)',
      enabled: true,
    });
    expect(item(buildSettingsMenu({ showCheckedOutBadge: true, showFolderCounts: true, trackingOrder: 'visualStudio' }), 'toggleTrackingOrder')).toMatchObject({
      label: 'Commit Counters: Switch to ↓ ↑ (VS Code)',
      enabled: true,
    });
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

  it('disables Fetch, Pull, Push and New Branch while busy, but still allows Refresh', () => {
    const menu = menuFor(snapshot, { isBusy: true });
    expect(enabled(menu)).toEqual(['refresh']);
    expect(item(menu, 'fetchTracked').reason).toMatch(/running/i);
    expect(item(menu, 'applyPatch')).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/running/i),
    });
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
    expect(clampMenuPosition(750, 580, 200, 100, 800, 600)).toEqual({ left: 592, top: 492 });
  });

  it('never goes negative, even when the menu is larger than the viewport', () => {
    expect(clampMenuPosition(5, 5, 900, 700, 800, 600)).toEqual({ left: 8, top: 8 });
  });
});
