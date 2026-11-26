import { describe, expect, it } from 'vitest';
import type { CreateWorktreeDialogPayload } from '../src/webview/ui/worktreeCreateModel';
import {
  createInitialWorktreeFormState,
  joinDisplayPath,
  setWorktreeExistingBranch,
  setWorktreeFormMode,
  suggestWorktreeFolderName,
  updateWorktreeFolderName,
  updateWorktreeNewBranchName,
  updateWorktreeParentFolder,
  validateWorktreeCreateForm,
} from '../src/webview/ui/worktreeCreateModel';

const request = (overrides: Partial<CreateWorktreeDialogPayload> = {}): CreateWorktreeDialogPayload => ({
  repoRoot: '/repos/demo-app',
  repoName: 'demo-app',
  defaultParentPath: '/repos',
  existingChildNames: ['demo-app'],
  availableBranches: ['feature/one', 'release'],
  allLocalBranchNames: ['main', 'feature/one', 'release'],
  initialBranchName: 'feature/pdj/Worktree1',
  branchLocked: false,
  ...overrides,
});

describe('create worktree form model', () => {
  it('sanitizes branch folder suggestions and avoids case-insensitive collisions', () => {
    expect(suggestWorktreeFolderName('feature/pdj/Worktree1', 'demo-app', [])).toBe('Worktree1_wt');
    expect(suggestWorktreeFolderName('feature/a?b', 'demo-app', ['A-B_WT', 'a-b_wt_2']))
      .toBe('a-b_wt_3');
    expect(suggestWorktreeFolderName('...', 'demo-app', [])).toBe('demo-app_wt');
  });

  it('preserves the path separator style in destination previews', () => {
    expect(joinDisplayPath('C:\\repos\\', 'topic_wt')).toBe('C:\\repos\\topic_wt');
    expect(joinDisplayPath('/home/user/repos', 'topic_wt')).toBe('/home/user/repos/topic_wt');
  });

  it('auto-updates suggestions until the folder name is edited', () => {
    const initial = createInitialWorktreeFormState(request());
    const switched = setWorktreeFormMode(initial, 'new');
    const typed = updateWorktreeNewBranchName(switched, 'feature/pdj/typed');
    expect(typed.folderName).toBe('typed_wt');
    const switchedBack = setWorktreeFormMode(typed, 'existing');
    expect(switchedBack.folderName).toBe('one_wt');
    const reparented = updateWorktreeParentFolder(switchedBack, '/worktrees', ['one_wt', 'ONE_WT_2']);
    expect(reparented.folderName).toBe('one_wt_3');
    const edited = updateWorktreeFolderName(reparented, 'custom');
    expect(updateWorktreeNewBranchName(setWorktreeFormMode(edited, 'new'), 'feature/changed').folderName)
      .toBe('custom');
    expect(updateWorktreeParentFolder(edited, '/another', []).folderName).toBe('custom');
  });

  it('locks mode and validates existing and new branch availability', () => {
    const locked = createInitialWorktreeFormState(request({
      initialBranchName: 'feature/one',
      branchLocked: true,
    }));
    expect(setWorktreeFormMode(locked, 'new').mode).toBe('existing');
    expect(validateWorktreeCreateForm({
      ...locked,
      selectedExistingBranch: 'main',
    })).toContain('already checked out');
    const newBranch = createInitialWorktreeFormState(request({
      initialBranchName: 'main',
      initialCreateBranch: true,
      branchLocked: true,
    }));
    expect(validateWorktreeCreateForm(newBranch)).toBe('Branch "main" already exists.');
  });

  it.each([
    '',
    '.',
    'a/b',
    'a\\b',
    'a..b',
    'bad:name',
    'trailing.',
    'trailing ',
    'CON',
    'NUL',
    'COM1',
    'LPT9',
    'con.txt',
  ])(
    'rejects invalid folder name %j',
    (folderName) => {
      const state = setWorktreeExistingBranch(createInitialWorktreeFormState(request()), 'feature/one');
      expect(validateWorktreeCreateForm(updateWorktreeFolderName(state, folderName))).not.toBeNull();
    },
  );

  it('rejects collisions and nested destinations but allows sibling worktree names', () => {
    const initial = setWorktreeExistingBranch(
      createInitialWorktreeFormState(request()),
      'feature/one',
    );
    expect(validateWorktreeCreateForm(updateWorktreeFolderName(
      updateWorktreeParentFolder(initial, '/repos', ['one_wt']),
      'one_wt',
    ))).toContain('already exists');
    expect(validateWorktreeCreateForm(updateWorktreeParentFolder(
      updateWorktreeFolderName(initial, 'nested'),
      '/repos/demo-app',
      [],
    ))).toContain('outside the repository');
    expect(validateWorktreeCreateForm(updateWorktreeParentFolder(
      updateWorktreeFolderName(initial, 'demo-app_wt'),
      '/repos',
      ['demo-app'],
    ))).toBeNull();
  });

  it.each([
    ['C:\\Repos\\App', 'C:\\Repos\\App', 'nested'],
    ['C:\\Repos\\App', 'c:/repos/app/sub', 'nested'],
    ['C:\\Repos\\App', 'C:\\repos\\APP', 'nested'],
  ])('rejects Windows destinations inside the repository for %s under %s', (repoRoot, parentFolderPath, folderName) => {
    const initial = createInitialWorktreeFormState(request({ repoRoot }));
    expect(validateWorktreeCreateForm(
      updateWorktreeFolderName(updateWorktreeParentFolder(initial, parentFolderPath, []), folderName),
    )).toContain('outside the repository');
  });

  it('allows Windows sibling destinations with the same path prefix', () => {
    const initial = createInitialWorktreeFormState(request({ repoRoot: 'C:\\Repos\\App' }));
    expect(validateWorktreeCreateForm(updateWorktreeFolderName(
      updateWorktreeParentFolder(initial, 'c:/repos', []),
      'App_wt',
    ))).toBeNull();
  });

  it('rejects duplicate and invalid names in new-branch mode', () => {
    const initial = setWorktreeFormMode(createInitialWorktreeFormState(request()), 'new');
    expect(validateWorktreeCreateForm(updateWorktreeNewBranchName(initial, 'main'))).toBe(
      'Branch "main" already exists.',
    );
    for (const branchName of ['feature//bad', 'bad..name', '-option']) {
      expect(validateWorktreeCreateForm(updateWorktreeNewBranchName(initial, branchName)))
        .toContain('valid Git ref');
    }
  });
});
