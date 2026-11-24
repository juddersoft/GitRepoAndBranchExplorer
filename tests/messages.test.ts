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

  it.each(['fetch', 'fetchTracked', 'pull', 'push', 'createBranch'] as GitAction[])('accepts %s without a target', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action }))).toBe(true);
  });

  it.each(['fetch', 'fetchTracked', 'pull', 'push', 'createBranch'] as GitAction[])('rejects %s carrying a target', (action) => {
    expect(isWebviewToExtensionMessage(gitAction({ action, target: 'main' }))).toBe(false);
  });

  it.each(['merge', 'rebase', 'deleteBranch', 'checkoutRemoteBranch'] as GitAction[])('requires a safe ref target for %s', (action) => {
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
  });
});

describe('createBranchAtRef validation', () => {
  const message = (startPoint: unknown): unknown => ({ type: 'createBranchAtRef', payload: { startPoint } });

  it('accepts a full commit hash or a safe ref name', () => {
    expect(isWebviewToExtensionMessage(message(HASH))).toBe(true);
    expect(isWebviewToExtensionMessage(message('origin/main'))).toBe(true);
    expect(isWebviewToExtensionMessage(message('v1.0.0'))).toBe(true);
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

