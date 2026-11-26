import { isSafeRefArgument } from '../../types/messages';
import { normalizeRepoKey } from './state';

export interface CreateWorktreeDialogPayload {
  readonly repoRoot: string;
  readonly repoName: string;
  readonly defaultParentPath: string;
  readonly existingChildNames: readonly string[];
  readonly availableBranches: readonly string[];
  readonly allLocalBranchNames: readonly string[];
  readonly initialBranchName?: string;
  readonly initialCreateBranch?: boolean;
  readonly branchLocked: boolean;
  readonly startPoint?: string;
}

export interface WorktreeCreateFormState {
  readonly mode: 'existing' | 'new';
  readonly branchLocked: boolean;
  readonly selectedExistingBranch: string;
  readonly newBranchName: string;
  readonly startPoint?: string;
  readonly parentFolderPath: string;
  readonly folderName: string;
  readonly folderNameEditedByUser: boolean;
  readonly openInNewWindow: boolean;
  readonly existingChildNames: readonly string[];
  readonly availableBranches: readonly string[];
  readonly allLocalBranchNames: readonly string[];
  readonly repoRoot: string;
  readonly repoName: string;
}

function sanitizeFolderPart(value: string): string {
  return value.replace(/[\\/<>:"|?*\x00-\x1f]/g, '-').replace(/^[. ]+|[. ]+$/g, '');
}

export function suggestWorktreeFolderName(
  branchName: string,
  repoName: string,
  existingChildNames: readonly string[],
): string {
  const shortBranch = branchName.slice(branchName.lastIndexOf('/') + 1);
  const branchPart = sanitizeFolderPart(shortBranch);
  const base = `${branchPart || sanitizeFolderPart(repoName)}_wt`;
  const existing = new Set(existingChildNames.map((name) => name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) {
    return base;
  }
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function selectedBranchName(state: WorktreeCreateFormState): string {
  return state.mode === 'existing' ? state.selectedExistingBranch : state.newBranchName.trim();
}

function refreshFolderSuggestion(state: WorktreeCreateFormState): WorktreeCreateFormState {
  if (state.folderNameEditedByUser) {
    return state;
  }
  return {
    ...state,
    folderName: suggestWorktreeFolderName(
      selectedBranchName(state),
      state.repoName,
      state.existingChildNames,
    ),
  };
}

export function createInitialWorktreeFormState(payload: CreateWorktreeDialogPayload): WorktreeCreateFormState {
  const mode = payload.initialCreateBranch === true ? 'new' : 'existing';
  const initialBranch = payload.initialBranchName ?? '';
  const selectedExistingBranch = payload.availableBranches.includes(initialBranch)
    ? initialBranch
    : payload.availableBranches[0] ?? '';
  const state: WorktreeCreateFormState = {
    mode,
    branchLocked: payload.branchLocked,
    selectedExistingBranch,
    newBranchName: mode === 'new' ? initialBranch : '',
    ...(payload.startPoint === undefined ? {} : { startPoint: payload.startPoint }),
    parentFolderPath: payload.defaultParentPath,
    folderName: '',
    folderNameEditedByUser: false,
    openInNewWindow: true,
    existingChildNames: payload.existingChildNames,
    availableBranches: payload.availableBranches,
    allLocalBranchNames: payload.allLocalBranchNames,
    repoRoot: payload.repoRoot,
    repoName: payload.repoName,
  };
  return refreshFolderSuggestion(state);
}

export function setWorktreeFormMode(
  state: WorktreeCreateFormState,
  mode: 'existing' | 'new',
): WorktreeCreateFormState {
  if (state.branchLocked || state.mode === mode) {
    return state;
  }
  return refreshFolderSuggestion({ ...state, mode });
}

export function setWorktreeExistingBranch(
  state: WorktreeCreateFormState,
  selectedExistingBranch: string,
): WorktreeCreateFormState {
  return refreshFolderSuggestion({ ...state, selectedExistingBranch });
}

export function updateWorktreeNewBranchName(
  state: WorktreeCreateFormState,
  newBranchName: string,
): WorktreeCreateFormState {
  return refreshFolderSuggestion({ ...state, newBranchName });
}

export function updateWorktreeParentFolder(
  state: WorktreeCreateFormState,
  parentFolderPath: string,
  existingChildNames: readonly string[],
): WorktreeCreateFormState {
  return refreshFolderSuggestion({ ...state, parentFolderPath, existingChildNames });
}

export function updateWorktreeFolderName(
  state: WorktreeCreateFormState,
  folderName: string,
): WorktreeCreateFormState {
  return { ...state, folderName, folderNameEditedByUser: true };
}

export function setWorktreeOpenInNewWindow(
  state: WorktreeCreateFormState,
  openInNewWindow: boolean,
): WorktreeCreateFormState {
  return { ...state, openInNewWindow };
}

export function joinDisplayPath(parentFolderPath: string, folderName: string): string {
  const parent = parentFolderPath;
  if (!parent || !folderName) {
    return parent || folderName;
  }
  const separator = parent.includes('\\') || /^[A-Za-z]:/.test(parent) ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${folderName}`;
}

function isPathInsideRepo(candidate: string, repoRoot: string): boolean {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(candidate) || /^[A-Za-z]:[\\/]/.test(repoRoot);
  const normalizedCandidate = normalizeRepoKey(candidate);
  const normalizedRoot = normalizeRepoKey(repoRoot);
  const comparableCandidate = windowsPath ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableRoot = windowsPath ? normalizedRoot.toLowerCase() : normalizedRoot;
  const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  return comparableCandidate === comparableRoot || comparableCandidate.startsWith(rootPrefix);
}

export function isValidGitBranchName(name: string): boolean {
  return !(
    !isSafeRefArgument(name) ||
    /\s/.test(name) ||
    ['..', '@{', '~', '^', ':', '?', '*', '[', '\\'].some((sequence) => name.includes(sequence)) ||
    name === '@' ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('//') ||
    name.split('/').some(
      (segment) => segment === '.' || segment === '..' || segment.startsWith('.') || segment.endsWith('.lock'),
    )
  );
}

export function validateWorktreeCreateForm(state: WorktreeCreateFormState): string | null {
  if (state.mode === 'existing') {
    if (!state.selectedExistingBranch) {
      return 'Select an available branch.';
    }
    if (!state.availableBranches.includes(state.selectedExistingBranch)) {
      return `Branch "${state.selectedExistingBranch}" is already checked out in a worktree.`;
    }
  } else {
    const branchName = state.newBranchName.trim();
    if (!isValidGitBranchName(branchName)) {
      return branchName.length === 0 ? 'Branch name is required.' : 'Branch name is not a valid Git ref.';
    }
    if (state.allLocalBranchNames.includes(branchName)) {
      return `Branch "${branchName}" already exists.`;
    }
  }

  const folderName = state.folderName.trim();
  if (!folderName) {
    return 'Worktree folder name is required.';
  }
  if (state.folderName === '.' || state.folderName.includes('..') || /[/\\]/.test(state.folderName)) {
    return 'Worktree folder name must be a single folder name, not a path.';
  }
  if (/[<>:"|?*\x00-\x1f]/.test(state.folderName)) {
    return 'Worktree folder name contains invalid filename characters.';
  }
  if (/[. ]$/.test(state.folderName)) {
    return 'Worktree folder name cannot end with a dot or space.';
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(state.folderName)) {
    return 'Worktree folder name is reserved by Windows.';
  }
  if (!state.parentFolderPath.trim()) {
    return 'Parent folder path is required.';
  }
  if (
    state.existingChildNames.some(
      (name) => name.toLowerCase() === state.folderName.toLowerCase(),
    )
  ) {
    return `A file or folder named "${state.folderName}" already exists in the parent folder.`;
  }
  const destinationPath = joinDisplayPath(state.parentFolderPath, state.folderName);
  if (isPathInsideRepo(state.parentFolderPath, state.repoRoot) || isPathInsideRepo(destinationPath, state.repoRoot)) {
    return 'Choose a parent folder outside the repository to avoid nesting the new worktree.';
  }
  return null;
}
