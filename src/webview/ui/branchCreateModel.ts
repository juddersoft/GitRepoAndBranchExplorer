import { isSafeRefArgument } from '../../types/messages';

export type CreateBranchSourceKind = 'remote' | 'local' | 'tag' | 'commit' | 'head';

export interface CreateBranchDialogRequest {
  readonly sourceKind: CreateBranchSourceKind;
  readonly startPoint?: string;
  readonly startLabel: string;
  readonly initialName: string;
  readonly remoteTrackingRef?: string;
  readonly existingLocalBranches: readonly string[];
}

export interface CreateBranchFormState {
  readonly branchName: string;
  readonly checkout: boolean;
  readonly track: boolean;
  readonly canTrack: boolean;
  readonly initialSuggestedName: string;
}

export function extractShortRemoteBranchName(remoteBranchFullOrShort: string, remoteName?: string): string {
  const remotesPrefix = 'refs/remotes/';
  let branch = remoteBranchFullOrShort.startsWith(remotesPrefix)
    ? remoteBranchFullOrShort.slice(remotesPrefix.length)
    : remoteBranchFullOrShort;
  if (remoteName !== undefined && branch.startsWith(`${remoteName}/`)) {
    return branch.slice(remoteName.length + 1);
  }
  const slash = branch.indexOf('/');
  return slash >= 0 ? branch.slice(slash + 1) : branch;
}

export function createInitialBranchFormState(request: CreateBranchDialogRequest): CreateBranchFormState {
  const canTrack = request.sourceKind === 'remote' && Boolean(request.remoteTrackingRef);
  return {
    branchName: request.initialName,
    checkout: true,
    track: canTrack,
    canTrack,
    initialSuggestedName: request.initialName,
  };
}

export function updateBranchFormName(state: CreateBranchFormState, nextName: string): CreateBranchFormState {
  return {
    ...state,
    branchName: nextName,
    track: state.canTrack && nextName.trim() !== state.initialSuggestedName ? false : state.track,
  };
}

export function setBranchFormCheckout(state: CreateBranchFormState, checkout: boolean): CreateBranchFormState {
  return { ...state, checkout };
}

export function setBranchFormTrack(state: CreateBranchFormState, track: boolean): CreateBranchFormState {
  return { ...state, track: state.canTrack && track };
}

export function validateCreateBranchForm(
  state: CreateBranchFormState,
  existingLocalBranches: readonly string[],
): string | null {
  const name = state.branchName.trim();
  if (name.length === 0) {
    return 'Branch name is required.';
  }
  if (
    !isSafeRefArgument(name) ||
    /\s/.test(name) ||
    ['..', '@{', '~', '^', ':', '?', '*', '[', '\\'].some((sequence) => name.includes(sequence)) ||
    name === '@' ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('//') ||
    name.split('/').some((segment) => segment === '.' || segment === '..' || segment.startsWith('.') || segment.endsWith('.lock'))
  ) {
    return 'Branch name is not a valid Git ref.';
  }
  if (existingLocalBranches.includes(name)) {
    return `Branch "${name}" already exists.`;
  }
  return null;
}
