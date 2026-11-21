import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  isTrusted: true,
}));

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted(): boolean {
      return mocks.isTrusted;
    },
  },
  Uri: { from: (value: unknown) => value },
}));

import { GitService } from '../src/git/gitService';
import {
  GIT_SHOW_SCHEME,
  GitShowContentProvider,
  isAuthorizedRepoRoot,
  normalizeRepoRootPath,
  REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE,
  WORKSPACE_TRUST_REQUIRED_MESSAGE,
} from '../src/git/gitDiffProvider';

describe('Git diff repository authorization', () => {
  it('normalizes trailing separators and Windows casing', () => {
    expect(normalizeRepoRootPath('/repo/project///', 'linux')).toBe('/repo/project');
    expect(normalizeRepoRootPath('C:\\Repo\\Project\\', 'win32')).toBe('c:\\repo\\project');
    expect(normalizeRepoRootPath('/', 'linux')).toBe('/');
    expect(normalizeRepoRootPath('C:\\', 'win32')).toBe('c:\\');
  });

  it('authorizes only normalized roots present in the allowlist', () => {
    const roots = new Set(['/repo/project', '/repo/other']);
    expect(isAuthorizedRepoRoot('/repo/project/', roots, 'linux')).toBe(true);
    expect(isAuthorizedRepoRoot('/repo/project/../secret', roots, 'linux')).toBe(false);
  });

  it('allows Windows case-insensitive authorized roots but rejects prefix collisions and traversal', () => {
    const roots = new Set(['C:\\Repos\\MyApp']);
    expect(isAuthorizedRepoRoot('c:\\repos\\myapp\\', roots, 'win32')).toBe(true);
    expect(isAuthorizedRepoRoot('C:\\Repos\\MyAppEvil', roots, 'win32')).toBe(false);
    expect(isAuthorizedRepoRoot('C:\\Repos\\MyApp\\..\\OtherRepo', roots, 'win32')).toBe(false);
    expect(isAuthorizedRepoRoot('C:\\Users\\Victim\\SecretRepo', roots, 'win32')).toBe(false);
  });

  it('rejects POSIX sibling prefix collisions and traversal paths', () => {
    const roots = new Set(['/repos/myapp']);
    expect(isAuthorizedRepoRoot('/repos/myapp/', roots, 'linux')).toBe(true);
    expect(isAuthorizedRepoRoot('/repos/myapp-evil', roots, 'linux')).toBe(false);
    expect(isAuthorizedRepoRoot('/repos/myapp/../other', roots, 'linux')).toBe(false);
  });

  it('rejects sibling, traversal and unrelated roots at provideTextDocumentContent', () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => 'contents')));
    provider.setAllowedRepoRoots(['C:\\Repos\\MyApp']);
    for (const candidate of [
      'C:\\Repos\\MyAppEvil',
      'C:\\Repos\\MyApp\\..\\OtherRepo',
      'C:\\Users\\Victim\\SecretRepo',
    ]) {
      expect(() => provider.provideTextDocumentContent(showUri(candidate))).toThrow(
        REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE,
      );
    }
  });

  it('rejects malformed, missing and non-object diff URI queries', () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => 'contents')));
    provider.setAllowedRepoRoots(['/repos/myapp']);
    for (const query of [
      'not-json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ repoRoot: '/repos/myapp' }),
      JSON.stringify({ revSpec: `${'a'.repeat(40)}:src/file.ts` }),
    ]) {
      const uri = { scheme: GIT_SHOW_SCHEME, query } as vscode.Uri;
      expect(() => provider.provideTextDocumentContent(uri)).toThrow();
    }
  });

  it('rejects reads in untrusted workspaces before consulting the allowlist or Git', () => {
    const runGit = vi.fn(async () => 'contents');
    const provider = new GitShowContentProvider(new GitService(runGit));
    const uri = showUri('/repo/project');
    mocks.isTrusted = false;

    expect(() => provider.provideTextDocumentContent(uri)).toThrow(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    expect(runGit).not.toHaveBeenCalled();
    mocks.isTrusted = true;
  });

  it('rejects roots outside the active repository allowlist', () => {
    const runGit = vi.fn(async () => 'contents');
    const provider = new GitShowContentProvider(new GitService(runGit));
    provider.setAllowedRepoRoots(['/repo/allowed']);

    expect(() => provider.provideTextDocumentContent(showUri('/repo/other'))).toThrow(
      REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE,
    );
    expect(runGit).not.toHaveBeenCalled();
  });

  it('allows an authorized root and clears authorization explicitly', async () => {
    const runGit = vi.fn(async () => 'contents');
    const provider = new GitShowContentProvider(new GitService(runGit));
    const uri = showUri('/repo/allowed');
    provider.setAllowedRepoRoots(['/repo/allowed/']);

    await expect(provider.provideTextDocumentContent(uri)).resolves.toBe('contents');
    provider.clearAllowedRepoRoots();
    expect(() => provider.provideTextDocumentContent(uri)).toThrow(REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE);
  });
});

function showUri(repoRoot: string): vscode.Uri {
  return {
    scheme: GIT_SHOW_SCHEME,
    query: JSON.stringify({ repoRoot, revSpec: `${'a'.repeat(40)}:src/file.ts` }),
  } as vscode.Uri;
}
