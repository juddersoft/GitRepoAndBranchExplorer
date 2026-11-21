import type { BranchInfo, RemoteGroup } from '../types/git';

/**
 * Pure planning for "Fetch" in the repository menu. This module must stay free of Node/VS Code imports: the
 * browser-bundled menu model uses it to decide whether Fetch is available.
 */
export interface TrackedFetchPlan {
  /** Remotes to fetch: those that at least one local branch tracks. */
  remotes: string[];
  /** Local branches whose upstream is a branch of a known remote. */
  trackedBranches: string[];
  /** Local branches skipped because they have no upstream or track a local branch / unknown remote. */
  skippedBranches: string[];
}

export interface TrackedFetchResult extends TrackedFetchPlan {
  fetchedRemotes: string[];
}

/** Remote an upstream such as `origin/main` belongs to; the longest matching name wins (remotes may contain `/`). */
function remoteOfUpstream(upstream: string, remoteNames: readonly string[]): string | null {
  let best: string | null = null;
  for (const name of remoteNames) {
    if (upstream.startsWith(`${name}/`) && upstream.length > name.length + 1 && (best === null || name.length > best.length)) {
      best = name;
    }
  }
  return best;
}

export function planTrackedFetch(localBranches: readonly BranchInfo[], remoteGroups: readonly RemoteGroup[]): TrackedFetchPlan {
  const remoteNames = remoteGroups.map((group) => group.remoteName);
  const remotes: string[] = [];
  const trackedBranches: string[] = [];
  const skippedBranches: string[] = [];

  for (const branch of localBranches) {
    if (branch.isRemote) {
      continue;
    }
    const remote = branch.upstream ? remoteOfUpstream(branch.upstream, remoteNames) : null;
    if (remote === null) {
      skippedBranches.push(branch.name);
      continue;
    }
    trackedBranches.push(branch.name);
    if (!remotes.includes(remote)) {
      remotes.push(remote);
    }
  }
  return { remotes, trackedBranches, skippedBranches };
}

const MAX_LISTED_BRANCHES = 3;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function listBranches(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED_BRANCHES).join(', ');
  return names.length > MAX_LISTED_BRANCHES ? `${shown} and ${names.length - MAX_LISTED_BRANCHES} more` : shown;
}

/** One-line summary shown after a tracked fetch finishes. */
export function describeTrackedFetch(result: TrackedFetchResult): string {
  const fetched = `Fetched ${result.fetchedRemotes.join(', ')} for ${plural(result.trackedBranches.length, 'tracked branch', 'tracked branches')}.`;
  return result.skippedBranches.length === 0
    ? fetched
    : `${fetched} Skipped ${plural(result.skippedBranches.length, 'branch', 'branches')} without an upstream: ${listBranches(result.skippedBranches)}.`;
}

/** Message for the repository menu when there is nothing to fetch. */
export const NOTHING_TO_FETCH_MESSAGE = 'No local branch tracks a remote branch, so there is nothing to fetch.';
