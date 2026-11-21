import { describe, expect, it } from 'vitest';
import { describeTrackedFetch, planTrackedFetch } from '../src/git/trackedFetch';
import type { BranchInfo, RemoteGroup } from '../src/types/git';

function local(name: string, upstream: string | null, patch: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    displayName: name,
    fullName: `refs/heads/${name}`,
    isCurrent: false,
    isRemote: false,
    remoteName: null,
    tipHash: 'a'.repeat(40),
    upstream,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    ...patch,
  };
}

const remote = (remoteName: string): RemoteGroup => ({ remoteName, branches: [] });

describe('planTrackedFetch', () => {
  it('fetches each tracked remote once and skips branches without an upstream', () => {
    const plan = planTrackedFetch(
      [local('main', 'origin/main'), local('dev', 'origin/dev'), local('scratch', null), local('fork-fix', 'fork/fix')],
      [remote('origin'), remote('fork'), remote('idle')],
    );
    expect(plan).toEqual({
      remotes: ['origin', 'fork'],
      trackedBranches: ['main', 'dev', 'fork-fix'],
      skippedBranches: ['scratch'],
    });
  });

  it('skips branches that track a local branch or an unknown remote', () => {
    const plan = planTrackedFetch([local('a', 'main'), local('b', 'ghost/main'), local('c', '')], [remote('origin')]);
    expect(plan).toEqual({ remotes: [], trackedBranches: [], skippedBranches: ['a', 'b', 'c'] });
  });

  it('still fetches for a branch whose upstream is gone, so the stale tracking ref is pruned', () => {
    const plan = planTrackedFetch([local('old', 'origin/old', { upstreamGone: true })], [remote('origin')]);
    expect(plan.remotes).toEqual(['origin']);
  });

  it('prefers the longest matching remote name and ignores remote branch records', () => {
    const plan = planTrackedFetch(
      [local('x', 'team/fork/x'), { ...local('origin/main', null), isRemote: true }],
      [remote('team'), remote('team/fork')],
    );
    expect(plan).toEqual({ remotes: ['team/fork'], trackedBranches: ['x'], skippedBranches: [] });
  });
});

describe('describeTrackedFetch', () => {
  const base = { remotes: ['origin'], trackedBranches: ['main'], skippedBranches: [], fetchedRemotes: ['origin'] };

  it('summarizes a clean fetch', () => {
    expect(describeTrackedFetch(base)).toBe('Fetched origin for 1 tracked branch.');
  });

  it('lists skipped branches and truncates long lists', () => {
    expect(describeTrackedFetch({ ...base, trackedBranches: ['a', 'b'], skippedBranches: ['s1'] })).toBe(
      'Fetched origin for 2 tracked branches. Skipped 1 branch without an upstream: s1.',
    );
    expect(describeTrackedFetch({ ...base, skippedBranches: ['s1', 's2', 's3', 's4', 's5'] })).toContain(
      'Skipped 5 branches without an upstream: s1, s2, s3 and 2 more.',
    );
  });
});
