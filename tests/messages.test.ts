import { describe, expect, it } from 'vitest';
import {
  GIT_ACTION_LABELS,
  GIT_ACTION_TARGETS,
  isExtensionToWebviewMessage,
  isSafeRefArgument,
  isWebviewToExtensionMessage,
  MAX_SYNC_PINNED_REFS,
} from '../src/types/messages';
import type { GitAction } from '../src/types/messages';

const HASH = 'a'.repeat(40);
const SHA256 = 'B'.repeat(64);

const gitAction = (payload: unknown): unknown => ({ type: 'gitAction', payload });

describe('gitAction validation', () => {
  it('declares a target kind and label for every action', () => {
    expect(Object.keys(GIT_ACTION_TARGETS).sort()).toEqual(Object.keys(GIT_ACTION_LABELS).sort());
  });

  it.each(['fetch', 'fetchTracked', 'pull', 'push', 'pushAndOpenPr', 'createPrInBrowser', 'openRepoInBrowser', 'createBranch', 'publishRepository'] as GitAction[])('accepts %s without a target', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(true);
  });

  it.each(['fetch', 'fetchTracked', 'pull', 'openRepoInBrowser', 'createBranch', 'publishRepository'] as GitAction[])('rejects %s carrying a target', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'main' }))).toBe(false);
  });

  it.each(['push', 'pushAndOpenPr', 'createPrInBrowser'] as GitAction[])('accepts an optional safe ref for %s', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'feature/x' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: '--force' }))).toBe(false);
  });

  it('validates browser action target kinds', () => {
    expect(isWebviewToExtensionMessage(gitAction({ action: 'openBranchInBrowser', target: 'origin/main' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action: 'openBranchInBrowser' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action: 'openCommitInBrowser', target: HASH }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action: 'openCommitInBrowser', target: 'main' }))).toBe(false);
  });

  it('validates worktree actions while rejecting control-bearing paths', () => {
    expect(isWebviewToExtensionMessage(gitAction({ action: 'createWorktree' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action: 'createWorktree', target: 'feature/x' }))).toBe(true);
    for (const action of ['openWorktree', 'removeWorktree', 'copyWorktreePath'] as GitAction[]) {
      expect(isWebviewToExtensionMessage(gitAction({ action, target: 'C:\\worktrees\\feature branch' }))).toBe(true);
      expect(isWebviewToExtensionMessage(gitAction({ action, target: 'bad\0path' }))).toBe(false);
      expect(isWebviewToExtensionMessage(gitAction({ action, target: 'bad\npath' }))).toBe(false);
      expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(false);
    }
  });

  it.each(['merge', 'rebase', 'deleteBranch', 'checkoutRemoteBranch', 'renameBranch', 'untrackBranch'] as GitAction[])('requires a safe ref target for %s', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'origin/feature/x' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: '' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: '--force' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'has space' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'a\nb' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'x'.repeat(256) }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 42 }))).toBe(false);
  });

  it.each(['cherryPick', 'revert', 'revertMerge'] as GitAction[])('requires a full commit hash for %s', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action, target: HASH }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: SHA256 }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'HEAD' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: HASH.slice(0, 8) }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(false);
  });

  it.each(['resetMixed', 'resetHard'] as GitAction[])('requires a safe ref or full commit hash for %s', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action, target: HASH }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: SHA256 }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'refs/heads/main' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'origin/main' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: '--hard' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: '-c' }))).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'HEAD~1' }))).toBe(true);
    expect(isWebviewToExtensionMessage(gitAction({ action, target: HASH.slice(0, 8) }))).toBe(true);
  });

  it('rejects unknown, inherited and non-string actions', () => {
    for (const action of ['reset', 'toString', '__proto__', '', 7, null]) {
      expect(isWebviewToExtensionMessage(gitAction({ action })), String(action)).toBe(false);
    }
    expect(isWebviewToExtensionMessage({ type: 'gitAction' })).toBe(false);
    expect(isWebviewToExtensionMessage(gitAction({ action: 'publishRepository', extra: true }))).toBe(false);
  });
});

describe('stash message validation', () => {
  it('accepts all five strict stash messages', () => {
    expect(isWebviewToExtensionMessage({ type: 'stashChanges' })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'inspectStash', ref: 'stash@{0}', hash: HASH })).toBe(true);
    for (const type of ['applyStash', 'popStash', 'dropStash'] as const) {
      expect(isWebviewToExtensionMessage({ type, ref: 'stash@{12}' })).toBe(true);
    }
  });

  it('rejects unsafe refs, invalid inspect hashes, and missing fields', () => {
    for (const ref of ['stash', 'stash@{-1}', 'stash@{x}', '--all', ' stash@{0}', 'stash@{0} ']) {
      expect(isWebviewToExtensionMessage({ type: 'applyStash', ref })).toBe(false);
    }
    expect(isWebviewToExtensionMessage({ type: 'inspectStash', ref: 'stash@{0}', hash: HASH.slice(0, 8) })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'inspectStash', ref: 'stash@{0}' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'dropStash' })).toBe(false);
  });

  it('rejects unexpected and prototype-pollution properties on every stash message', () => {
    const messages = [
      { type: 'stashChanges' },
      { type: 'inspectStash', ref: 'stash@{0}', hash: HASH },
      { type: 'applyStash', ref: 'stash@{0}' },
      { type: 'popStash', ref: 'stash@{0}' },
      { type: 'dropStash', ref: 'stash@{0}' },
    ];
    for (const message of messages) {
      expect(isWebviewToExtensionMessage({ ...message, extra: true })).toBe(false);
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const polluted = JSON.parse(JSON.stringify(message).replace(/}$/, `,"${key}":{}}`)) as unknown;
        expect(isWebviewToExtensionMessage(polluted), `${message.type}.${key}`).toBe(false);
      }
    }
  });
});

describe('stash snapshot validation', () => {
  const snapshot = (stashes: unknown[]): unknown => ({
    type: 'repoSnapshot',
    payload: {
      repoName: 'repo',
      repoRoot: '/repo',
      currentBranch: 'main',
      isDetachedHead: false,
      localBranches: [],
      remoteGroups: [],
      worktrees: [],
      stashes,
      tags: [],
      commits: [],
      hasMoreCommits: false,
    },
  });
  const stash = {
    index: 0,
    ref: 'stash@{0}',
    hash: HASH,
    message: 'saved work',
    timestamp: 1700000000,
  };

  it('accepts valid stash entries and requires the stash list', () => {
    expect(isExtensionToWebviewMessage(snapshot([stash]))).toBe(true);
    expect(isExtensionToWebviewMessage(snapshot([]))).toBe(true);
    const withoutStashes = snapshot([]);
    delete (withoutStashes as { payload: { stashes?: unknown[] } }).payload.stashes;
    expect(isExtensionToWebviewMessage(withoutStashes)).toBe(true);
  });

  it('rejects malformed, mismatched and polluted stash entries', () => {
    expect(isExtensionToWebviewMessage(snapshot([{ ...stash, ref: 'stash@{1}' }]))).toBe(false);
    expect(isExtensionToWebviewMessage(snapshot([{ ...stash, hash: 'short' }]))).toBe(false);
    expect(isExtensionToWebviewMessage(snapshot([{ ...stash, timestamp: -1 }]))).toBe(false);
    expect(isExtensionToWebviewMessage(snapshot([JSON.parse(
      `{"index":0,"ref":"stash@{0}","hash":"${HASH}","message":"saved","timestamp":1,"__proto__":{}}`,
    )]))).toBe(false);
  });
});

describe('createBranchAtRef validation', () => {
  const message = (startPoint: unknown): unknown => ({ type: 'createBranchAtRef', payload: { startPoint } });

  it('accepts a full commit hash or a safe ref name', () => {
    expect(isWebviewToExtensionMessage(message(HASH))).toBe(true);
    expect(isWebviewToExtensionMessage(message('origin/main'))).toBe(true);
    expect(isWebviewToExtensionMessage(message('v1.0.0'))).toBe(true);
  });

  describe('create branch dialog messages', () => {
    it('validates open and submit requests', () => {
      expect(isWebviewToExtensionMessage({
        type: 'openCreateBranchDialog',
        payload: { startPoint: 'refs/remotes/origin/main', sourceKind: 'remote' },
      })).toBe(true);
      expect(isWebviewToExtensionMessage({
        type: 'submitCreateBranch',
        payload: { branchName: 'feature/x', startPoint: HASH, checkout: true, track: false },
      })).toBe(true);
    });

    it('rejects malformed create branch payloads and polluted records', () => {
      expect(isWebviewToExtensionMessage({ type: 'openCreateBranchDialog', payload: { sourceKind: 'unknown' } })).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'submitCreateBranch',
        payload: { branchName: 'feature/x', checkout: 'yes', track: false },
      })).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'submitCreateBranch',
        payload: { branchName: 'feature/x', checkout: true, track: false, extra: true },
      })).toBe(false);
      const payload = JSON.parse('{"branchName":"feature/x","checkout":true,"track":false,"__proto__":{}}');
      expect(isWebviewToExtensionMessage({ type: 'submitCreateBranch', payload })).toBe(false);
    });

    it('validates dialog requests sent by the extension', () => {
      expect(isExtensionToWebviewMessage({
        type: 'showCreateBranchDialog',
        payload: {
          sourceKind: 'remote',
          startPoint: 'refs/remotes/origin/main',
          startLabel: 'origin/main',
          initialName: 'main',
          remoteTrackingRef: 'origin/main',
          existingLocalBranches: ['main'],
        },
      })).toBe(true);
    });
  });

  describe('create worktree dialog messages', () => {
    it('validates browse, submit, and extension dialog requests', () => {
      expect(isWebviewToExtensionMessage({
        type: 'browseWorktreeParentFolder',
        payload: { currentParentPath: '/worktrees' },
      })).toBe(true);
      expect(isWebviewToExtensionMessage({
        type: 'submitCreateWorktree',
        payload: {
          branchName: 'feature/new',
          createBranch: true,
          startPoint: 'main',
          parentFolderPath: '/worktrees',
          folderName: 'new_wt',
          openInNewWindow: true,
        },
      })).toBe(true);
      expect(isExtensionToWebviewMessage({
        type: 'showCreateWorktreeDialog',
        payload: {
          repoRoot: '/repo',
          repoName: 'repo',
          defaultParentPath: '/',
          existingChildNames: ['repo'],
          availableBranches: ['main'],
          allLocalBranchNames: ['main'],
          initialBranchName: 'feature/new',
          initialCreateBranch: true,
          branchLocked: true,
          startPoint: 'main',
        },
      })).toBe(true);
      expect(isExtensionToWebviewMessage({
        type: 'worktreeParentFolderSelected',
        payload: { parentFolderPath: '/other', existingChildNames: [] },
      })).toBe(true);
    });

    it('rejects extra fields, unsafe strings, and polluted records', () => {
      expect(isWebviewToExtensionMessage({
        type: 'submitCreateWorktree',
        payload: {
          branchName: 'feature/new',
          createBranch: true,
          parentFolderPath: '/worktrees',
          folderName: 'new_wt',
          openInNewWindow: true,
          extra: true,
        },
      })).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'browseWorktreeParentFolder',
        payload: { currentParentPath: 'bad\u0000path' },
      })).toBe(false);
      const payload = JSON.parse(
        '{"repoRoot":"/repo","repoName":"repo","defaultParentPath":"/","existingChildNames":[],' +
        '"availableBranches":[],"allLocalBranchNames":[],"branchLocked":false,"__proto__":{}}',
      );
      expect(isExtensionToWebviewMessage({ type: 'showCreateWorktreeDialog', payload })).toBe(false);
    });

    it.each(['__proto__', 'constructor', 'prototype'])(
      'rejects the %s pollution key on worktree requests',
      (key) => {
        const browsePayload = JSON.parse(`{"currentParentPath":"/worktrees","${key}":{}}`) as unknown;
        const submitPayload = JSON.parse(
          `{"branchName":"feature/new","createBranch":true,"parentFolderPath":"/worktrees",` +
          `"folderName":"new_wt","openInNewWindow":true,"${key}":{}}`,
        ) as unknown;
        expect(isWebviewToExtensionMessage({ type: 'browseWorktreeParentFolder', payload: browsePayload }))
          .toBe(false);
        expect(isWebviewToExtensionMessage({ type: 'submitCreateWorktree', payload: submitPayload }))
          .toBe(false);
      },
    );

    it('rejects unexpected properties on both worktree request envelopes and payloads', () => {
      expect(isWebviewToExtensionMessage({
        type: 'browseWorktreeParentFolder',
        payload: { currentParentPath: '/worktrees' },
        extra: true,
      })).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'browseWorktreeParentFolder',
        payload: { currentParentPath: '/worktrees', extra: true },
      })).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'submitCreateWorktree',
        payload: {
          branchName: 'feature/new',
          createBranch: true,
          parentFolderPath: '/worktrees',
          folderName: 'new_wt',
          openInNewWindow: true,
        },
        extra: true,
      })).toBe(false);
    });
  });

  it('rejects option-like, empty, oversized and non-string start points', () => {
    for (const value of ['', '-b', '--orphan', 'a b', 'x'.repeat(256), 1, undefined]) {
      expect(isWebviewToExtensionMessage(message(value)), String(value)).toBe(false);
    }
    expect(isWebviewToExtensionMessage({ type: 'createBranchAtRef' })).toBe(false);
  });
});

describe('setTabPinned validation', () => {
  it('accepts only a boolean', () => {
    expect(isWebviewToExtensionMessage({ type: 'setTabPinned', payload: { pinned: true } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setTabPinned', payload: { pinned: false } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setTabPinned', payload: { pinned: 'yes' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setTabPinned', payload: {} })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setTabPinned' })).toBe(false);
  });
});

describe('commit pagination validation', () => {
  it('accepts loadMoreCommits without a payload', () => {
    expect(isWebviewToExtensionMessage({ type: 'loadMoreCommits' })).toBe(true);
  });

  describe('repository selection validation', () => {
    it('accepts a non-empty control-free repository path', () => {
      expect(isWebviewToExtensionMessage({
        type: 'selectRepository',
        payload: { repoRoot: '/work/another repo' },
      })).toBe(true);
    });

    it('rejects missing, empty, control-bearing and extra payload fields', () => {
      for (const payload of [{}, { repoRoot: '' }, { repoRoot: ' \t' }, { repoRoot: 'bad\0path' }, { repoRoot: '/repo', extra: true }]) {
        expect(isWebviewToExtensionMessage({ type: 'selectRepository', payload })).toBe(false);
      }
    });

    it('rejects non-plain and prototype-polluted messages and payloads', () => {
      expect(isWebviewToExtensionMessage(Object.assign(new Date(), {
        type: 'selectRepository',
        payload: { repoRoot: '/repo' },
      }))).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'selectRepository',
        payload: Object.create({ repoRoot: '/repo' }),
      })).toBe(false);
      expect(isWebviewToExtensionMessage({
        type: 'selectRepository',
        payload: JSON.parse('{"repoRoot":"/repo","__proto__":{"polluted":true}}'),
      })).toBe(false);
      expect(isWebviewToExtensionMessage(JSON.parse(
        '{"type":"selectRepository","payload":{"repoRoot":"/repo"},"constructor":{}}',
      ))).toBe(false);
    });

    it('validates workspace repository broadcasts', () => {
      const repo = { repoRoot: '/repo', repoName: 'repo', commonDir: '/repo/.git', currentBranch: 'main' };
      expect(isExtensionToWebviewMessage({
        type: 'workspaceRepos',
        payload: { repos: [repo], activeRepoRoot: '/repo' },
      })).toBe(true);
      expect(isExtensionToWebviewMessage({
        type: 'workspaceRepos',
        payload: { repos: [{ ...repo, repoRoot: '' }], activeRepoRoot: null },
      })).toBe(false);
    });
  });
});

describe('setShowCheckedOutBadge validation', () => {
  it('accepts only a boolean show', () => {
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge', payload: { show: true } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge', payload: { show: false } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge', payload: { show: 'yes' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge', payload: { show: 1 } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge', payload: {} })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge' })).toBe(false);
  });

  it('rejects prototype-pollution keys', () => {
    const payload = JSON.parse('{"show":true,"__proto__":{"polluted":true}}') as unknown;
    expect(isWebviewToExtensionMessage({ type: 'setShowCheckedOutBadge', payload })).toBe(false);
    expect(isWebviewToExtensionMessage(JSON.parse('{"type":"setShowCheckedOutBadge","payload":{"show":true},"constructor":{}}'))).toBe(false);
  });
});

describe('setShowFolderCounts validation', () => {
  it('accepts only a boolean show', () => {
    expect(isWebviewToExtensionMessage({ type: 'setShowFolderCounts', payload: { show: true } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setShowFolderCounts', payload: { show: false } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'setShowFolderCounts', payload: { show: 'yes' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setShowFolderCounts', payload: {} })).toBe(false);
  });

  it('rejects prototype-pollution keys', () => {
    const payload = JSON.parse('{"show":true,"__proto__":{"polluted":true}}') as unknown;
    expect(isWebviewToExtensionMessage({ type: 'setShowFolderCounts', payload })).toBe(false);
  });
});

describe('openFile validation', () => {
  const open = (overrides: Record<string, unknown>): unknown => ({
    type: 'openFile',
    payload: { hash: HASH, filePath: 'src/a.ts', status: 'M', ...overrides },
  });

  it('accepts safe commit-file requests', () => {
    expect(isWebviewToExtensionMessage(open({}))).toBe(true);
    expect(isWebviewToExtensionMessage(open({ status: 'D' }))).toBe(true);
  });

  it.each(['../a.ts', 'src/../../a.ts', '/a.ts', '\\a.ts', 'C:a.ts', 'C:\\a.ts', 'src\\a.ts\0'])(
    'rejects unsafe path %j',
    (filePath) => {
      expect(isWebviewToExtensionMessage(open({ filePath }))).toBe(false);
    },
  );

  it('rejects control characters, invalid hashes and statuses, and oversized paths', () => {
    expect(isWebviewToExtensionMessage(open({ hash: 'HEAD' }))).toBe(false);
    expect(isWebviewToExtensionMessage(open({ status: 'unknown' }))).toBe(false);
    expect(isWebviewToExtensionMessage(open({ filePath: 'a\nb' }))).toBe(false);
    expect(isWebviewToExtensionMessage(open({ filePath: 'x'.repeat(4097) }))).toBe(false);
  });

  it('rejects prototype-pollution keys', () => {
    const polluted = JSON.parse(`{"type":"openFile","payload":{"hash":"${HASH}","filePath":"a.ts","status":"M","__proto__":{"x":1}}}`);
    expect(isWebviewToExtensionMessage(polluted)).toBe(false);
  });
});

describe('setTrackingOrder validation', () => {
  it.each(['vscode', 'visualStudio'])('accepts %s', (order) => {
    expect(isWebviewToExtensionMessage({ type: 'setTrackingOrder', payload: { order } })).toBe(true);
  });

  it.each(['default', '', 123, null, undefined])('rejects invalid order %j', (order) => {
    expect(isWebviewToExtensionMessage({ type: 'setTrackingOrder', payload: { order } })).toBe(false);
  });

  it('rejects missing and prototype-polluted payloads', () => {
    expect(isWebviewToExtensionMessage({ type: 'setTrackingOrder' })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'setTrackingOrder', payload: {} })).toBe(false);
    const payload = JSON.parse('{"order":"vscode","__proto__":{"polluted":true}}') as unknown;
    expect(isWebviewToExtensionMessage({ type: 'setTrackingOrder', payload })).toBe(false);
  });
});

describe('context-menu commit and integration messages', () => {
  it('still validates copyCommitHash, openCommitOnGitHub and openInGitGraph', () => {
    expect(isWebviewToExtensionMessage({ type: 'copyCommitHash', payload: { hash: HASH } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'openCommitOnGitHub', payload: { hash: HASH } })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: 'openCommitOnGitHub', payload: { hash: 'HEAD' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'openInGitGraph' })).toBe(true);
  });
});

describe('isSafeRefArgument', () => {
  it('accepts ordinary ref names', () => {
    for (const ref of ['main', 'feature/x', 'origin/release-1.2', 'v1.0.0', 'unicode-caf\u00e9']) {
      expect(isSafeRefArgument(ref), ref).toBe(true);
    }
  });

  it('rejects anything that could be parsed as an option or break argument boundaries', () => {
    for (const ref of ['-x', '--help', 'a b', 'a\tb', 'a\0b', '\x7f', '']) {
      expect(isSafeRefArgument(ref), JSON.stringify(ref)).toBe(false);
    }
  });
});

describe('syncState validation', () => {
  const sync = (payload: unknown): unknown => ({ type: 'syncState', payload });
  const valid = {
    selectedBranchFullName: 'refs/remotes/origin/main',
    selectedBranchRef: 'origin/main',
    pinnedBranchFullNames: ['refs/heads/main', 'refs/heads/feature/x'],
  };

  it('accepts a selection, an empty selection and an empty pin list in both directions', () => {
    const empty = { selectedBranchFullName: null, selectedBranchRef: null, pinnedBranchFullNames: [] };
    for (const payload of [valid, empty]) {
      expect(isWebviewToExtensionMessage(sync(payload))).toBe(true);
      expect(isExtensionToWebviewMessage(sync(payload))).toBe(true);
    }
  });

  it('rejects a half-set selection and unsafe or non-string ref names', () => {
    const bad: unknown[] = [
      { ...valid, selectedBranchRef: null },
      { ...valid, selectedBranchFullName: null },
      { ...valid, selectedBranchFullName: '--force' },
      { ...valid, selectedBranchRef: 'has space' },
      { ...valid, selectedBranchFullName: 7 },
      { ...valid, pinnedBranchFullNames: ['refs/heads/ok', '-x'] },
      { ...valid, pinnedBranchFullNames: ['refs/heads/a\nb'] },
      { ...valid, pinnedBranchFullNames: [1] },
      { ...valid, pinnedBranchFullNames: 'refs/heads/main' },
      { selectedBranchFullName: null, selectedBranchRef: null },
    ];
    for (const payload of bad) {
      expect(isWebviewToExtensionMessage(sync(payload)), JSON.stringify(payload)).toBe(false);
      expect(isExtensionToWebviewMessage(sync(payload)), JSON.stringify(payload)).toBe(false);
    }
    expect(isWebviewToExtensionMessage({ type: 'syncState' })).toBe(false);
  });

  it('bounds the number of pinned refs and rejects prototype-pollution keys', () => {
    const many = Array.from({ length: MAX_SYNC_PINNED_REFS + 1 }, (_, i) => `refs/heads/b${i}`);
    expect(isWebviewToExtensionMessage(sync({ ...valid, pinnedBranchFullNames: many }))).toBe(false);
    expect(isWebviewToExtensionMessage(sync({ ...valid, pinnedBranchFullNames: many.slice(1) }))).toBe(true);
    const polluted = JSON.parse('{"selectedBranchFullName":null,"selectedBranchRef":null,"pinnedBranchFullNames":[],"__proto__":{"x":1}}');
    expect(isWebviewToExtensionMessage(sync(polluted))).toBe(false);
  });
});

describe('initState tabPinned', () => {
  it('accepts an optional boolean tabPinned', () => {
    const initState = (extra: Record<string, unknown>): unknown => ({
      type: 'initState',
      payload: { repoName: 'r', workspacePath: null, ...extra },
    });
    expect(isExtensionToWebviewMessage(initState({}))).toBe(true);
    expect(isExtensionToWebviewMessage(initState({ tabPinned: true }))).toBe(true);
    expect(isExtensionToWebviewMessage(initState({ tabPinned: 'no' }))).toBe(false);
  });

  it('accepts an optional boolean showCheckedOutBadge', () => {
    const initState = (extra: Record<string, unknown>): unknown => ({
      type: 'initState',
      payload: { repoName: 'r', workspacePath: null, ...extra },
    });
    expect(isExtensionToWebviewMessage(initState({ showCheckedOutBadge: false }))).toBe(true);
    expect(isExtensionToWebviewMessage(initState({ showCheckedOutBadge: 'no' }))).toBe(false);
  });

  it('accepts a boolean showFolderCounts', () => {
    const initState = (extra: Record<string, unknown>): unknown => ({
      type: 'initState',
      payload: { repoName: 'r', workspacePath: null, ...extra },
    });
    expect(isExtensionToWebviewMessage(initState({ showFolderCounts: true }))).toBe(true);
    expect(isExtensionToWebviewMessage(initState({ showFolderCounts: false }))).toBe(true);
    expect(isExtensionToWebviewMessage(initState({ showFolderCounts: 'no' }))).toBe(false);
  });

  it('accepts only supported trackingOrder values', () => {
    const initState = (trackingOrder: unknown): unknown => ({
      type: 'initState',
      payload: { repoName: 'r', workspacePath: null, trackingOrder },
    });
    expect(isExtensionToWebviewMessage(initState('vscode'))).toBe(true);
    expect(isExtensionToWebviewMessage(initState('visualStudio'))).toBe(true);
    expect(isExtensionToWebviewMessage(initState('default'))).toBe(false);
    expect(isExtensionToWebviewMessage(initState(1))).toBe(false);
    expect(isExtensionToWebviewMessage(initState(null))).toBe(false);
  });
});

