import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  isTrusted: true,
  executeCommand: vi.fn(async () => undefined),
  showTextDocument: vi.fn(async () => undefined),
}));

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted(): boolean {
      return mocks.isTrusted;
    },
  },
  Uri: {
    from: (value: unknown) => value,
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
  },
  commands: { executeCommand: mocks.executeCommand },
  window: { showTextDocument: mocks.showTextDocument },
}));

import { GitService } from '../src/git/gitService';
import {
  GIT_SHOW_SCHEME,
  GitShowContentProvider,
  buildShowUri,
  buildVersionedDisplayPath,
  formatRevisionTag,
  isAuthorizedRepoRoot,
  normalizeRepoRootPath,
  REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE,
  WORKSPACE_TRUST_REQUIRED_MESSAGE,
} from '../src/git/gitDiffProvider';

describe('Phase 20 file history diff helpers', () => {
  it('builds versioned display paths without losing directories or extensions', () => {
    expect(buildVersionedDisplayPath('src/git/gitService.ts', 'OLDER abc12345 • 2026-11-10'))
      .toBe('src/git/gitService [OLDER abc12345 • 2026-11-10].ts');
    expect(buildVersionedDisplayPath('file.ts', 'NEWER abc12345')).toBe('file [NEWER abc12345].ts');
    expect(buildVersionedDisplayPath('.gitignore', 'COMMIT abc12345')).toBe('.gitignore [COMMIT abc12345]');
    expect(buildVersionedDisplayPath('Makefile', 'PREVIOUS abc12345')).toBe('Makefile [PREVIOUS abc12345]');
  });

  it('formats revision tags and rejects invalid or missing ISO dates', () => {
    expect(formatRevisionTag('OLDER', 'abc12345', '2026-11-10T12:00:00+00:00'))
      .toBe('OLDER abc12345 • 2026-11-10');
    expect(formatRevisionTag('NEWER', 'def67890', 'not-a-date')).toBe('NEWER def67890');
    expect(formatRevisionTag('COMMIT', '12345678')).toBe('COMMIT 12345678');
  });

  it('buildShowUri preserves the display path and query while parseQuery accepts it', () => {
    const uri = buildShowUri('/repo/project', 'a'.repeat(40) + ':src/file.ts', 'src/file.ts', 'OLDER abc12345 • 2026-11-10');
    expect((uri as unknown as { path: string }).path)
      .toBe('/src/file [OLDER abc12345 • 2026-11-10].ts');
    expect(JSON.parse((uri as unknown as { query: string }).query)).toEqual({
      repoRoot: '/repo/project',
      revSpec: 'a'.repeat(40) + ':src/file.ts',
    });
  });

  it('rejects untrusted workspaces before opening any diff or document', async () => {
    mocks.isTrusted = false;
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    const older = { hash: 'a'.repeat(40), shortHash: 'a'.repeat(8), path: 'src/a.ts', isoDate: '2026-11-10T00:00:00Z' };
    const newer = { hash: 'b'.repeat(40), shortHash: 'b'.repeat(8), path: 'src/a.ts', isoDate: '2026-11-11T00:00:00Z' };
    await expect(provider.openTwoRevisionFileDiff('/repo', older, newer)).rejects.toThrow(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    await expect(provider.openRevisionVsWorkingTreeDiff('/repo', { hash: older.hash, shortHash: older.shortHash, pathAtCommit: older.path }, 'src/a.ts')).rejects.toThrow(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    await expect(provider.openSingleRevisionFile('/repo', { hash: older.hash, shortHash: older.shortHash, pathAtCommit: older.path })).rejects.toThrow(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    mocks.isTrusted = true;
  });

  it('opens a clearly labeled two-revision diff and versioned rename URIs', async () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    mocks.executeCommand.mockClear();
    await provider.openTwoRevisionFileDiff(
      '/repo',
      { hash: 'a'.repeat(40), shortHash: 'a'.repeat(8), path: 'src/old.ts', isoDate: '2026-11-10T12:00:00Z' },
      { hash: 'b'.repeat(40), shortHash: 'b'.repeat(8), path: 'src/new.ts', isoDate: '2026-11-11T12:00:00Z' },
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ path: '/src/old [OLDER aaaaaaaa • 2026-11-10].ts' }),
      expect.objectContaining({ path: '/src/new [NEWER bbbbbbbb • 2026-11-11].ts' }),
      'old.ts → new.ts — OLDER (aaaaaaaa • 2026-11-10) ↔ NEWER (bbbbbbbb • 2026-11-11)',
      { preview: true },
    );
  });

  it('rejects working-tree traversal and opens a working-tree diff for valid paths', async () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    mocks.executeCommand.mockClear();
    await expect(provider.openRevisionVsWorkingTreeDiff(
      '/repo',
      { hash: 'a'.repeat(40), shortHash: 'a'.repeat(8), pathAtCommit: 'src/file.ts' },
      '../outside.ts',
    )).rejects.toThrow(/inside the repository/);
    await provider.openRevisionVsWorkingTreeDiff(
      '/repo',
      { hash: 'a'.repeat(40), shortHash: 'a'.repeat(8), pathAtCommit: 'src/file.ts', isoDate: '2026-11-10T12:00:00Z' },
      'src/file.ts',
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ path: '/src/file [OLDER aaaaaaaa • 2026-11-10].ts' }),
      expect.objectContaining({ scheme: 'file', fsPath: expect.stringMatching(/file\.ts$/) }),
      'file.ts — OLDER (aaaaaaaa • 2026-11-10) ↔ WORKING TREE',
      { preview: true },
    );
  });

  it('opens a single revision as a versioned read-only document', async () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    mocks.showTextDocument.mockClear();
    await provider.openSingleRevisionFile('/repo', {
      hash: 'c'.repeat(40),
      shortHash: 'c'.repeat(8),
      pathAtCommit: 'src/file.ts',
      isoDate: '2026-11-12T12:00:00Z',
    });
    expect(mocks.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/src/file [COMMIT cccccccc • 2026-11-12].ts' }),
      { preview: true },
    );
  });
});

describe('Phase 20 reference comparison diffs', () => {
  it('rejects untrusted workspaces', async () => {
    mocks.isTrusted = false;
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    await expect(provider.openReferenceFileDiff(
      '/repo',
      { hash: 'a'.repeat(40), label: 'main' },
      { hash: 'b'.repeat(40), label: 'feature' },
      { filePath: 'src/file.ts', status: 'M' },
    )).rejects.toThrow(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    mocks.isTrusted = true;
  });

  it('sanitizes labels in display paths and preserves intact parseable URI queries', async () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    mocks.executeCommand.mockClear();
    const dirtyBase = `main/branch\\name[]\u0001` + 'x'.repeat(50);
    const dirtyTarget = `feature[1]\\name/\u0007` + 'y'.repeat(50);
    await provider.openReferenceFileDiff(
      '/repo/project',
      { hash: 'a'.repeat(40), label: dirtyBase },
      { hash: 'b'.repeat(40), label: dirtyTarget },
      { filePath: 'src/file.ts', status: 'M' },
    );
    const [, left, right, title] = mocks.executeCommand.mock.calls[0];
    const leftUri = left as unknown as { path: string; query: string };
    const rightUri = right as unknown as { path: string; query: string };
    expect(leftUri.path).not.toMatch(/[\\\x00-\x1f\x7f]/);
    expect(rightUri.path).not.toMatch(/[\\\x00-\x1f\x7f]/);
    expect(leftUri.path).not.toContain('name]');
    expect(rightUri.path).not.toContain('name[');
    expect(leftUri.path).toContain('[BASE ');
    expect(rightUri.path).toContain('[TARGET ');
    expect(JSON.parse(leftUri.query)).toEqual({
      repoRoot: '/repo/project',
      revSpec: `${'a'.repeat(40)}:src/file.ts`,
    });
    expect(JSON.parse(rightUri.query)).toEqual({
      repoRoot: '/repo/project',
      revSpec: `${'b'.repeat(40)}:src/file.ts`,
    });
    expect(title).toContain('BASE (');
    expect(title).toContain('↔ TARGET (');
  });

  it('uses unmistakable BASE and TARGET URI tags and title labels', async () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    mocks.executeCommand.mockClear();
    await provider.openReferenceFileDiff(
      '/repo',
      { hash: 'a'.repeat(40), label: 'main' },
      { hash: 'b'.repeat(40), label: 'release/v1' },
      { filePath: 'src/file.ts', status: 'M' },
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ path: expect.stringContaining('[BASE main •') }),
      expect.objectContaining({ path: expect.stringContaining('[TARGET releasev1 •') }),
      'file.ts — BASE (main) ↔ TARGET (release/v1)',
      { preview: true },
    );
  });

  it('uses oldPath on the base URI and renders old basename to new basename for renames and copies', async () => {
    const provider = new GitShowContentProvider(new GitService(vi.fn(async () => '')));
    for (const status of ['R', 'C'] as const) {
      mocks.executeCommand.mockClear();
      await provider.openReferenceFileDiff(
        '/repo',
        { hash: 'a'.repeat(40), label: 'main' },
        { hash: 'b'.repeat(40), label: 'feature' },
        { filePath: 'src/new-name.ts', oldPath: 'src/old-name.ts', status },
      );
      expect(mocks.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.objectContaining({ query: JSON.stringify({ repoRoot: '/repo', revSpec: `${'a'.repeat(40)}:src/old-name.ts` }) }),
        expect.objectContaining({ query: JSON.stringify({ repoRoot: '/repo', revSpec: `${'b'.repeat(40)}:src/new-name.ts` }) }),
        'old-name.ts → new-name.ts — BASE (main) ↔ TARGET (feature)',
        { preview: true },
      );
    }
  });
});

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
