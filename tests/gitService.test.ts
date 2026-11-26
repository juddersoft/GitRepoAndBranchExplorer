import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { execGit, GitExecutionError, validateGitRef } from '../src/git/gitExecutor';
import type { GitRunner } from '../src/git/gitService';
import {
  buildGitHubCommitUrl,
  buildRefMap,
  findGitHubRemoteInVerbose,
  GitService,
  isValidCommitHash,
  NETWORK_GIT_TIMEOUT_MS,
  normalizeGitHubRemoteUrl,
  parseDiffTreeOutput,
  parseForEachRefOutput,
  parseGitLogOutput,
  parsePorcelainStatusZ,
  parseStashListOutput,
  parseUpstreamTrack,
  parseWorktreeListPorcelain,
  validateStashRef,
  validateRevSpec,
  WORKTREE_GIT_TIMEOUT_MS,
} from '../src/git/gitService';
import type { BranchInfo, RefBadge, RemoteGroup } from '../src/types/git';

const FS = '\x1f';
const RS = '\x1e';

const sha = (char: string): string => char.repeat(40);

describe('execGit process hardening', () => {
  it('disables the ext:: transport for every invocation', async () => {
    await expect(execGit(['config', '--get', 'protocol.ext.allow'], process.cwd())).resolves.toBe('never\n');
  });

  it('terminates and rejects when stdout exceeds the configured cap', async () => {
    const error = await execGit(['--version'], process.cwd(), { maxStdoutBytes: 1 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitExecutionError);
    expect(error).toMatchObject({ outputLimitExceeded: true });
    expect((error as GitExecutionError).message).toContain('stdout output limit exceeded');
  });

  it('terminates and rejects when stderr exceeds the configured cap', async () => {
    const error = await execGit(['show', '0000000000000000000000000000000000000000'], process.cwd(), {
      maxStderrBytes: 1,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitExecutionError);
    expect(error).toMatchObject({ outputLimitExceeded: true });
    expect((error as GitExecutionError).message).toContain('stderr output limit exceeded');
  });
});

/** Mirrors git's output: fields joined by 0x1f, each record ending with 0x1e plus git's trailing newline. */
function records(...rows: string[][]): string {
  return rows.map((fields) => `${fields.join(FS)}${RS}\n`).join('');
}

function logRecord(hash: string, parents: string[], subject: string, timestamp = '1700000000'): string[] {
  return [hash, hash.slice(0, 7), parents.join(' '), subject, 'Ada Lovelace', 'ada@example.com', '2023-11-14T22:13:20+00:00', timestamp];
}

describe('validateGitRef', () => {
  it.each(['feature/branch-6', 'release/v1.0.0', 'main', 'origin/feature_x'])('accepts %s', (ref) => {
    expect(validateGitRef(ref)).toBe(ref);
  });

  it('returns the trimmed ref', () => {
    expect(validateGitRef('  main  ')).toBe('main');
  });

  it.each([
    ['-evil', /start with "-"/],
    ['--upload-pack=evil', /start with "-"/],
    ['branch..main', /"\.\."/],
    ['foo bar', /whitespace/],
    ['', /empty/],
    ['   ', /empty/],
    ['main\nrm', /control/],
    ['a\x00b', /control/],
    ['HEAD@{1}', /"@\{"/],
    ['HEAD~1', /"~"/],
    ['HEAD^', /"\^"/],
    ['a:b', /":"/],
    ['what?', /"\?"/],
    ['feat*', /"\*"/],
    ['feat[1]', /"\["/],
    ['a\\b', /"\\"/],
    ['branch.lock', /valid ref/],
    ['feature/', /valid ref/],
  ])('rejects %j', (ref, message) => {
    expect(() => validateGitRef(ref)).toThrow(message);
  });
});

describe('parseUpstreamTrack', () => {
  it.each([
    ['[ahead 1]', { ahead: 1, behind: 0, upstreamGone: false }],
    ['[behind 4]', { ahead: 0, behind: 4, upstreamGone: false }],
    ['[ahead 2, behind 5]', { ahead: 2, behind: 5, upstreamGone: false }],
    ['[gone]', { ahead: 0, behind: 0, upstreamGone: true }],
    ['', { ahead: 0, behind: 0, upstreamGone: false }],
  ])('parses %j', (track, expected) => {
    expect(parseUpstreamTrack(track)).toEqual(expected);
  });

  describe('parsePorcelainStatusZ', () => {
    it('parses modified, added, deleted and untracked paths with spaces', () => {
      const raw = [
        ' M modified file.txt',
        'A  added file.txt',
        ' D deleted file.txt',
        '?? untracked file.txt',
        '',
      ].join('\0');
      expect(parsePorcelainStatusZ(raw)).toEqual([
        { path: 'modified file.txt', indexStatus: ' ', worktreeStatus: 'M', untracked: false },
        { path: 'added file.txt', indexStatus: 'A', worktreeStatus: ' ', untracked: false },
        { path: 'deleted file.txt', indexStatus: ' ', worktreeStatus: 'D', untracked: false },
        { path: 'untracked file.txt', indexStatus: '?', worktreeStatus: '?', untracked: true },
      ]);
    });

    it('consumes rename and copy original-path tokens without shifting later entries', () => {
      const raw = [
        'R  new name.txt',
        'old name.txt',
        'C  copied file.txt',
        'source file.txt',
        ' M after rename.txt',
        '',
      ].join('\0');
      expect(parsePorcelainStatusZ(raw)).toEqual([
        {
          path: 'new name.txt',
          indexStatus: 'R',
          worktreeStatus: ' ',
          untracked: false,
          originalPath: 'old name.txt',
        },
        {
          path: 'copied file.txt',
          indexStatus: 'C',
          worktreeStatus: ' ',
          untracked: false,
          originalPath: 'source file.txt',
        },
        { path: 'after rename.txt', indexStatus: ' ', worktreeStatus: 'M', untracked: false },
      ]);
    });
  });

  describe('parseStashListOutput', () => {
    it('parses stash refs, hashes, messages and timestamps', () => {
      const output = [
        `${sha('A')}${FS}stash@{0}${FS}WIP on main: work${FS}1700000000`,
        `${sha('b')}${FS}stash@{2}${FS}saved changes${FS}1699999999`,
      ].join('\n');
      expect(parseStashListOutput(output)).toEqual([
        {
          index: 0,
          ref: 'stash@{0}',
          hash: sha('a'),
          message: 'WIP on main: work',
          timestamp: 1700000000,
        },
        {
          index: 2,
          ref: 'stash@{2}',
          hash: sha('b'),
          message: 'saved changes',
          timestamp: 1699999999,
        },
      ]);
      expect(parseStashListOutput('')).toEqual([]);
    });

    it('rejects malformed stash refs, hashes and timestamps', () => {
      for (const output of [
        `${sha('a')}${FS}main${FS}message${FS}1700000000`,
        `${sha('a')}${FS}stash@{-1}${FS}message${FS}1700000000`,
        `bad${FS}stash@{0}${FS}message${FS}1700000000`,
        `${sha('a')}${FS}stash@{0}${FS}message${FS}not-a-time`,
      ]) {
        expect(() => parseStashListOutput(output)).toThrow(/invalid stash/i);
      }
    });
  });

  describe('validateStashRef', () => {
    it.each(['stash@{0}', 'stash@{1}', 'stash@{1234567890}'])('accepts %s', (ref) => {
      expect(validateStashRef(ref)).toBe(ref);
    });

    it.each(['', 'stash', 'stash@{-1}', 'stash@{x}', 'stash@{ 1}', ' stash@{0}', 'stash@{0} ', '--all', '-c'])(
      'rejects %j',
      (ref) => expect(() => validateStashRef(ref)).toThrow(/stash reference/i),
    );
  });

  describe('parseWorktreeListPorcelain', () => {
    it('parses linked, detached, bare, locked and prunable CRLF stanzas with paths containing spaces', () => {
      const output = [
        `worktree C:\\Repos\\Main Repo`,
        `HEAD ${sha('a')}`,
        'branch refs/heads/main',
        '',
        'worktree c:/worktrees/feature branch',
        `HEAD ${sha('b')}`,
        'branch refs/heads/feature/branch',
        'locked stale lock',
        'prunable gitdir file points to non-existent location',
        '',
        'worktree C:/Repos/detached',
        `HEAD ${sha('c')}`,
        'detached',
        '',
        'worktree C:/Repos/bare.git',
        'bare',
        '',
      ].join('\r\n');

      expect(parseWorktreeListPorcelain(output, 'c:/repos/main repo')).toEqual([
        {
          path: 'C:\\Repos\\Main Repo',
          headHash: sha('a'),
          branchName: 'main',
          isDetached: false,
          isBare: false,
          isMain: true,
          isCurrent: true,
          isLocked: false,
          isPrunable: false,
        },
        {
          path: 'c:/worktrees/feature branch',
          headHash: sha('b'),
          branchName: 'feature/branch',
          isDetached: false,
          isBare: false,
          isMain: false,
          isCurrent: false,
          isLocked: true,
          isPrunable: true,
        },
        {
          path: 'C:/Repos/detached',
          headHash: sha('c'),
          branchName: null,
          isDetached: true,
          isBare: false,
          isMain: false,
          isCurrent: false,
          isLocked: false,
          isPrunable: false,
        },
        {
          path: 'C:/Repos/bare.git',
          headHash: '',
          branchName: null,
          isDetached: false,
          isBare: true,
          isMain: false,
          isCurrent: false,
          isLocked: false,
          isPrunable: false,
        },
      ]);
    });
  });
});

describe('parseForEachRefOutput', () => {
  const raw = records(
    [' ', 'refs/heads/main', 'main', sha('a'), 'origin/main', '[behind 2]'],
    ['*', 'refs/heads/featurebranch3', 'featurebranch3', sha('b'), 'origin/featurebranch3', '[ahead 1, behind 3]'],
    [' ', 'refs/heads/local-only', 'local-only', sha('c'), '', ''],
    [' ', 'refs/heads/orphaned', 'orphaned', sha('c'), 'origin/deleted-upstream', '[gone]'],
    [' ', 'refs/remotes/upstream/main', 'upstream/main', sha('d'), '', ''],
    [' ', 'refs/remotes/origin/HEAD', 'origin', sha('a'), '', ''],
    [' ', 'refs/remotes/origin/main', 'origin/main', sha('a'), '', ''],
    [' ', 'refs/remotes/origin/featurebranch3', 'origin/featurebranch3', sha('e'), '', ''],
    [' ', 'refs/tags/v1.0.0', 'v1.0.0', sha('f'), '', ''],
    [' ', 'refs/tags/v2.0.0', 'v2.0.0', sha('1'), '', '', sha('2')],
  );
  const result = parseForEachRefOutput(raw);

  it('parses local branches with the current branch and tracking counts', () => {
    expect(result.localBranches.map((b) => b.name)).toEqual(['main', 'featurebranch3', 'local-only', 'orphaned']);
    expect(result.localBranches[1]).toEqual({
      name: 'featurebranch3',
      displayName: 'featurebranch3',
      fullName: 'refs/heads/featurebranch3',
      isCurrent: true,
      isRemote: false,
      remoteName: null,
      tipHash: sha('b'),
      upstream: 'origin/featurebranch3',
      ahead: 1,
      behind: 3,
      upstreamGone: false,
    });
    expect(result.localBranches[0]).toMatchObject({ isCurrent: false, ahead: 0, behind: 2 });
    expect(result.localBranches[2]).toMatchObject({ upstream: null, ahead: 0, behind: 0, upstreamGone: false });
  });

  it('flags a deleted upstream ([gone]) instead of reporting it as up to date', () => {
    expect(result.localBranches[3]).toMatchObject({ upstream: 'origin/deleted-upstream', ahead: 0, behind: 0, upstreamGone: true });
  });

  it('groups remotes alphabetically and drops the symbolic origin/HEAD', () => {
    expect(result.remoteGroups.map((g) => g.remoteName)).toEqual(['origin', 'upstream']);
    const origin = result.remoteGroups[0];
    expect(origin.branches.map((b) => b.name)).toEqual(['origin/main', 'origin/featurebranch3']);
    expect(origin.defaultBranch).toBe('main');
    expect(origin.branches[1]).toEqual({
      name: 'origin/featurebranch3',
      displayName: 'featurebranch3',
      fullName: 'refs/remotes/origin/featurebranch3',
      isCurrent: false,
      isRemote: true,
      remoteName: 'origin',
      tipHash: sha('e'),
      upstream: null,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
    });
  });

  it('parses refs/remotes/origin/HEAD symref as the remote default branch', () => {
    const parsed = parseForEachRefOutput(records(
      [' ', 'refs/remotes/origin/HEAD', 'origin/HEAD', sha('a'), '', '', '', 'refs/remotes/origin/main'],
      [' ', 'refs/remotes/origin/main', 'origin/main', sha('a'), '', ''],
    ));
    expect(parsed.remoteGroups).toEqual([
      {
        remoteName: 'origin',
        branches: [expect.objectContaining({ name: 'origin/main', displayName: 'main' })],
        defaultBranch: 'main',
      },
    ]);
  });

  it('falls back to main or master when HEAD symref is absent', () => {
    const mainOnly = parseForEachRefOutput(records(
      [' ', 'refs/remotes/origin/main', 'origin/main', sha('a'), '', ''],
      [' ', 'refs/remotes/origin/feature', 'origin/feature', sha('b'), '', ''],
    ));
    expect(mainOnly.remoteGroups[0].defaultBranch).toBe('main');

    const masterOnly = parseForEachRefOutput(records(
      [' ', 'refs/remotes/origin/master', 'origin/master', sha('a'), '', ''],
      [' ', 'refs/remotes/origin/feature', 'origin/feature', sha('b'), '', ''],
    ));
    expect(masterOnly.remoteGroups[0].defaultBranch).toBe('master');
  });

  it('leaves defaultBranch undefined when fallback is ambiguous', () => {
    const parsed = parseForEachRefOutput(records(
      [' ', 'refs/remotes/origin/main', 'origin/main', sha('a'), '', ''],
      [' ', 'refs/remotes/origin/master', 'origin/master', sha('b'), '', ''],
    ));
    expect(parsed.remoteGroups[0].defaultBranch).toBeUndefined();
  });

  it('parses tags and peels annotated tags to their commit', () => {
    expect(result.tags).toEqual([
      { name: 'v1.0.0', fullName: 'refs/tags/v1.0.0', targetHash: sha('f') },
      { name: 'v2.0.0', fullName: 'refs/tags/v2.0.0', targetHash: sha('2') },
    ]);
  });

  it('uses the full refname rather than a disambiguated short name', () => {
    const parsed = parseForEachRefOutput(records([' ', 'refs/heads/v1', 'heads/v1', sha('a'), '', '']));
    expect(parsed.localBranches[0].name).toBe('v1');
  });

  it('returns empty collections for empty output', () => {
    expect(parseForEachRefOutput('')).toEqual({ localBranches: [], remoteGroups: [], tags: [] });
  });
});

describe('parseGitLogOutput', () => {
  const root = sha('1');
  const second = sha('2');
  const side = sha('3');
  const merge = sha('4');

  const raw = records(
    logRecord(merge, [second, side], "Merge branch 'feature, (x)' into main"),
    logRecord(side, [root], 'fix: handle "quoted" | piped: values'),
    logRecord(second, [root], 'Second commit'),
    logRecord(root, [], 'Initial commit'),
  );

  const refMap = new Map<string, RefBadge[]>([
    [
      merge,
      [
        { kind: 'head', label: 'HEAD' },
        { kind: 'localBranch', label: 'main' },
        { kind: 'remoteBranch', label: 'origin/main' },
      ],
    ],
    [side, [{ kind: 'localBranch', label: 'feature, (x)' }]],
    [root, [{ kind: 'tag', label: 'v0.1.0' }]],
  ]);

  const commits = parseGitLogOutput(raw, refMap);

  it('parses every commit in order with 8-char short hashes', () => {
    expect(commits.map((c) => c.hash)).toEqual([merge, side, second, root]);
    expect(commits.every((c) => c.shortHash.length === 8)).toBe(true);
    expect(commits[2]).toEqual({
      hash: second,
      shortHash: second.slice(0, 8),
      parents: [root],
      subject: 'Second commit',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorDateIso: '2023-11-14T22:13:20+00:00',
      authorTimestamp: 1700000000,
      refs: [],
    });
  });

  it('handles root commits and merge commits', () => {
    expect(commits[3].parents).toEqual([]);
    expect(commits[0].parents).toEqual([second, side]);
  });

  it('preserves subjects containing quotes, pipes, colons, commas and parentheses', () => {
    expect(commits[0].subject).toBe("Merge branch 'feature, (x)' into main");
    expect(commits[1].subject).toBe('fix: handle "quoted" | piped: values');
  });

  it('preserves a subject that contains the field separator', () => {
    const [commit] = parseGitLogOutput(records(logRecord(root, [], `a${FS}b`)), new Map());
    expect(commit.subject).toBe(`a${FS}b`);
    expect(commit.authorName).toBe('Ada Lovelace');
  });

  it('attaches ref badges by hash without sharing the map arrays', () => {
    expect(commits[0].refs.map((r) => r.kind)).toEqual(['head', 'localBranch', 'remoteBranch']);
    expect(commits[1].refs).toEqual([{ kind: 'localBranch', label: 'feature, (x)' }]);
    expect(commits[3].refs).toEqual([{ kind: 'tag', label: 'v0.1.0' }]);
    expect(commits[0].refs).not.toBe(refMap.get(merge));
  });

  it('skips malformed records', () => {
    expect(parseGitLogOutput(`garbage${RS}\n${FS}${FS}${RS}`, new Map())).toEqual([]);
  });
});

describe('buildRefMap', () => {
  it('orders badges as HEAD, local, remote, tag', () => {
    const refs = parseForEachRefOutput(
      records(
        [' ', 'refs/tags/v1', 'v1', sha('a'), '', ''],
        [' ', 'refs/remotes/origin/main', 'origin/main', sha('a'), '', ''],
        ['*', 'refs/heads/main', 'main', sha('a'), 'origin/main', ''],
      ),
    );
    expect(buildRefMap(refs, sha('a')).get(sha('a'))).toEqual([
      { kind: 'head', label: 'HEAD' },
      { kind: 'localBranch', label: 'main' },
      { kind: 'remoteBranch', label: 'origin/main' },
      { kind: 'tag', label: 'v1' },
    ]);
  });
});

function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe('parseDiffTreeOutput', () => {
  const z = (...tokens: string[]): string => `${tokens.join('\0')}\0`;

  it('parses added, modified, deleted and type-changed files', () => {
    expect(parseDiffTreeOutput(z('A', 'src/new.ts', 'M', 'README.md', 'D', 'old.txt', 'T', 'link'))).toEqual([
      { status: 'A', path: 'src/new.ts' },
      { status: 'M', path: 'README.md' },
      { status: 'D', path: 'old.txt' },
      { status: 'T', path: 'link' },
    ]);
  });

  it('parses renames and copies with their score and oldPath', () => {
    expect(parseDiffTreeOutput(z('R100', 'a b.txt', 'c d.txt', 'C075', 'src/x.ts', 'src/y.ts', 'M', 'z.ts'))).toEqual([
      { status: 'R', path: 'c d.txt', oldPath: 'a b.txt' },
      { status: 'C', path: 'src/y.ts', oldPath: 'src/x.ts' },
      { status: 'M', path: 'z.ts' },
    ]);
  });

  it('keeps spaces, quotes, tabs, newlines and Unicode in file names verbatim', () => {
    const names = ['my file.txt', 'caf\u00e9/\u65e5\u672c\u8a9e.md', 'tab\there', 'new\nline', '"quoted".txt', '\u{1f680}.ts'];
    expect(parseDiffTreeOutput(z(...names.flatMap((n) => ['M', n]))).map((f) => f.path)).toEqual(names);
  });

  it('returns an empty list for empty output and skips unknown statuses', () => {
    expect(parseDiffTreeOutput('')).toEqual([]);
    expect(parseDiffTreeOutput(z('X', 'weird', 'A', 'ok.txt'))).toEqual([{ status: 'A', path: 'ok.txt' }]);
  });
});

describe('isValidCommitHash', () => {
  it.each(['a'.repeat(40), '0123456789abcdef0123456789ABCDEF01234567', 'f'.repeat(64), `${'0123456789abcdef'.repeat(3)}${'ABCDEF0123456789'}`])(
    'accepts %s',
    (hash) => {
      expect(isValidCommitHash(hash)).toBe(true);
    },
  );

  it.each([
    'a'.repeat(39),
    'a'.repeat(41),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(40),
    `${'f'.repeat(63)}g`,
    'HEAD',
    `-${'a'.repeat(39)}`,
    `${'a'.repeat(40)}\n`,
    `${'a'.repeat(64)}\n`,
    '',
    42,
    null,
  ])('rejects %s', (hash) => {
    expect(isValidCommitHash(hash)).toBe(false);
  });
});

describe('validateRevSpec', () => {
  const h = 'c'.repeat(40);

  it.each([`${h}:src/a.ts`, `${h}^:dir with space/file.md`, `${h}:-leading-dash.txt`, `${'d'.repeat(64)}^:a.txt`])('accepts %s', (spec) => {
    expect(validateRevSpec(spec)).toBe(spec);
  });

  it('lowercases the hash part only', () => {
    expect(validateRevSpec(`${'AB'.repeat(32)}^:Docs/README.md`)).toBe(`${'ab'.repeat(32)}^:Docs/README.md`);
  });

  it.each([
    `--output=/tmp/x`,
    `-${h}:a`,
    `${h}`,
    `HEAD:a.txt`,
    `${h}~1:a.txt`,
    `${h}:../secret`,
    `${h}:src/../../etc/passwd`,
    `${h}:/etc/passwd`,
    `${h}:C:/Windows/win.ini`,
    `${h}:a\0b`,
    `${h}:`,
  ])('rejects %j', (spec) => {
    expect(() => validateRevSpec(spec)).toThrow();
  });
});

describe('GitHub remote URL normalization', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
    ['git@github.com:owner/repo', 'https://github.com/owner/repo'],
    ['git@acme.ghe.com:owner/repo.git', 'https://acme.ghe.com/owner/repo'],
    ['ssh://git@acme.ghe.com/owner/repo', 'https://acme.ghe.com/owner/repo'],
    ['https://Acme.GHE.COM/owner/repo.git', 'https://acme.ghe.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['ssh://git@github.com:22/owner/repo.git', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo'],
    ['https://git@github.com/My-Org/my.repo.git\n', 'https://github.com/My-Org/my.repo'],
    ['http://github.com/owner/repo.git', 'https://github.com/owner/repo'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeGitHubRemoteUrl(input)).toBe(expected);
  });

  it.each([
    'https://gitlab.com/owner/repo.git',
    'git@bitbucket.org:owner/repo.git',
    'https://github.com.evil.com/owner/repo',
    'https://evil.com/github.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    'https://github.com/owner/<script>',
    'https://user@github.com/owner/repo',
    'https://user:pass@acme.ghe.com/owner/repo',
    'file:///home/me/repo',
    '',
  ])('rejects %s', (input) => {
    expect(normalizeGitHubRemoteUrl(input)).toBeNull();
  });

  it('picks origin first from `git remote -v`, then any GitHub remote', () => {
    const verbose = [
      'gitlab\thttps://gitlab.com/o/r.git (fetch)',
      'upstream\tgit@github.com:up/stream.git (fetch)',
      'origin\thttps://github.com/me/fork.git (fetch)',
    ].join('\n');
    expect(findGitHubRemoteInVerbose(verbose)).toBe('https://github.com/me/fork');
    expect(findGitHubRemoteInVerbose(verbose.split('\n').slice(0, 2).join('\n'))).toBe('https://github.com/up/stream');
    expect(findGitHubRemoteInVerbose('gitlab\thttps://gitlab.com/o/r.git (fetch)')).toBeNull();
  });

  it('builds commit URLs only for normalized GitHub URLs and valid hashes', () => {
    const hash = 'ABCDEF'.padEnd(40, '0');
    expect(buildGitHubCommitUrl('https://github.com/o/r', hash)).toBe(`https://github.com/o/r/commit/${hash.toLowerCase()}`);
    expect(buildGitHubCommitUrl('https://acme.ghe.com/o/r', hash)).toBe(
      `https://acme.ghe.com/o/r/commit/${hash.toLowerCase()}`,
    );
    expect(buildGitHubCommitUrl('http://github.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('http://acme.ghe.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://acme.ghe.com/o/r.git', hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://github.com.evil.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('javascript:alert(1)//https://github.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://github.com/o/r', 'HEAD')).toBeNull();
  });

  it('builds commit URLs for 64-character SHA-256 hashes and rejects near-miss lengths', () => {
    const sha256 = 'ABCDEF'.padEnd(64, '9');
    expect(buildGitHubCommitUrl('https://github.com/o/r', sha256)).toBe(`https://github.com/o/r/commit/${sha256.toLowerCase()}`);
    expect(buildGitHubCommitUrl('https://acme.ghe.com/o/r', sha256)).toBe(
      `https://acme.ghe.com/o/r/commit/${sha256.toLowerCase()}`,
    );
    for (const length of [39, 41, 63, 65]) {
      expect(buildGitHubCommitUrl('https://github.com/o/r', 'a'.repeat(length))).toBeNull();
    }
  });
});

describe('GitService operations (fake runner)', () => {
  const ROOT = path.resolve('repo');
  const HASH = 'd'.repeat(40);

  function recorder(respond: (args: readonly string[]) => string | Error = () => ''): {
    calls: Array<{ args: readonly string[]; timeoutMs?: number; maxStdoutBytes?: number }>;
    service: GitService;
  } {
    const calls: Array<{ args: readonly string[]; timeoutMs?: number; maxStdoutBytes?: number }> = [];
    const runner: GitRunner = (args, _cwd, options) => {
      calls.push({
        args,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
      });
      const result = respond(args);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    };
    return { calls, service: new GitService(runner) };
  }

  function trackedBranch(name: string, upstream: string | null): BranchInfo {
    return {
      name,
      displayName: name,
      fullName: `refs/heads/${name}`,
      isCurrent: false,
      isRemote: false,
      remoteName: null,
      tipHash: HASH,
      upstream,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
    };
  }

  function remoteGroup(remoteName: string): RemoteGroup {
    return { remoteName, branches: [] };
  }

  it('adds and removes worktrees using validated argument arrays', async () => {
    const { calls, service } = recorder();
    await service.addWorktree(ROOT, path.join(ROOT, 'feature worktree'), {
      branchName: 'feature/work',
      createBranch: true,
      startPoint: 'main',
    });
    await service.addWorktree(ROOT, path.join(ROOT, 'release-worktree'), { branchName: 'release' });
    await service.removeWorktree(ROOT, path.join(ROOT, 'release-worktree'), true);

    expect(calls.map((call) => call.args)).toEqual([
      ['worktree', 'add', '-b', 'feature/work', path.join(ROOT, 'feature worktree'), 'main'],
      ['worktree', 'add', path.join(ROOT, 'release-worktree'), 'release'],
      ['worktree', 'remove', '--force', path.join(ROOT, 'release-worktree')],
    ]);
    await expect(service.addWorktree(ROOT, '--option', { branchName: 'main' })).rejects.toThrow(/path/i);
  });

  it('reads date-ordered commit pages with N+1 overfetch and skip', async () => {
    const hashes = ['1', '2', '3'].map((char) => sha(char));
    const { calls, service } = recorder((args) => {
      if (args[0] === 'for-each-ref') {
        return records(['*', 'refs/heads/main', 'main', hashes[0], '', '']);
      }
      if (args[0] === 'symbolic-ref') {
        return 'refs/heads/main\n';
      }
      if (args[0] === 'rev-parse') {
        return `${hashes[0]}\n`;
      }
      if (args[0] === 'log') {
        return records(...hashes.map((hash, index) => logRecord(hash, [], `commit ${index}`)));
      }
      return '';
    });

    await expect(service.getCommitPage(ROOT, 7, 2)).resolves.toMatchObject({
      commits: [
        { hash: hashes[0], refs: [{ kind: 'head', label: 'HEAD' }, { kind: 'localBranch', label: 'main' }] },
        { hash: hashes[1], refs: [] },
      ],
      hasMoreCommits: true,
    });
    const logArgs = calls.find((call) => call.args[0] === 'log')?.args;
    expect(logArgs).toContain('--date-order');
    expect(logArgs).toContain('--max-count=3');
    expect(logArgs).toContain('--skip=7');
    expect(logArgs).not.toContain('--topo-order');
  });

  it('reports no more commits when the page fits within the limit', async () => {
    const hashes = ['a', 'b'].map((char) => sha(char));
    const { service } = recorder((args) => {
      if (args[0] === 'log') {
        return records(...hashes.map((hash) => logRecord(hash, [], 'commit')));
      }
      return '';
    });
    await expect(service.getCommitPage(ROOT, 0, 2)).resolves.toMatchObject({
      commits: [{ hash: hashes[0] }, { hash: hashes[1] }],
      hasMoreCommits: false,
    });
  });

  it('populates hasMoreCommits for the initial 500-commit snapshot page', async () => {
    const hashes = Array.from({ length: 501 }, (_, index) =>
      index.toString(16).padStart(40, '0'),
    );
    const { calls, service } = recorder((args) =>
      args[0] === 'log'
        ? records(...hashes.map((hash) => logRecord(hash, [], 'commit')))
        : args[0] === 'rev-parse' && args[1] === '--show-toplevel'
          ? `${ROOT}\n`
          : '',
    );
    const snapshot = await service.getRepoSnapshot(ROOT);
    expect(snapshot.commits).toHaveLength(500);
    expect(snapshot.hasMoreCommits).toBe(true);
    expect(calls.find((call) => call.args[0] === 'log')?.args).toContain('--max-count=501');
  });

  it('enriches configured remotes, including groups without fetched refs', async () => {
    const { service } = recorder((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return `${ROOT}\n`;
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return [
          'origin\thttps://github.com/owner/repo.git (fetch)',
          'origin\tgit@github.com:owner/repo.git (push)',
          String.raw`backup	C:\Repos\backup.git (fetch)`,
          String.raw`backup	C:\Repos\backup.git (push)`,
        ].join('\n');
      }
      if (args[0] === 'for-each-ref') {
        return records([' ', 'refs/remotes/origin/main', 'origin/main', HASH, '', '']);
      }
      return '';
    });

    const snapshot = await service.getRepoSnapshot(ROOT);
    expect(snapshot.remotes).toEqual(['backup', 'origin']);
    expect(snapshot.remoteGroups).toEqual([
      {
        remoteName: 'backup',
        branches: [],
        url: String.raw`C:\Repos\backup.git`,
        destinationKind: 'localPath',
      },
      {
        remoteName: 'origin',
        branches: [expect.objectContaining({ name: 'origin/main' })],
        defaultBranch: 'main',
        url: 'git@github.com:owner/repo.git',
        destinationKind: 'hosted',
        providerName: 'GitHub',
      },
    ]);
  });

  it('runs fetch, pull and push with network timeouts', async () => {
    const { calls, service } = recorder();
    await service.fetchAll(ROOT);
    await service.pullCurrentBranch(ROOT);
    await service.pushCurrentBranch(ROOT, 'main', true);
    await service.pushCurrentBranch(ROOT, 'feature/new', false);
    expect(calls).toEqual([
      { args: ['fetch', '--all', '--prune'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
      { args: ['pull'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
      { args: ['push'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
      { args: ['push', '-u', '--', 'origin', 'refs/heads/feature/new:refs/heads/feature/new'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
    ]);
  });

  it('pushes explicit local and remote branch refspecs with an option separator', async () => {
    const { calls, service } = recorder();
    await service.pushToRemoteBranch(ROOT, 'upstream', 'feature/local', 'feature/remote', true);
    await service.pushToRemoteBranch(ROOT, 'origin', 'topic', 'old-topic', false);
    expect(calls).toEqual([
      {
        args: ['push', '-u', '--', 'upstream', 'refs/heads/feature/local:refs/heads/feature/remote'],
        timeoutMs: NETWORK_GIT_TIMEOUT_MS,
      },
      {
        args: ['push', '--', 'origin', 'refs/heads/topic:refs/heads/old-topic'],
        timeoutMs: NETWORK_GIT_TIMEOUT_MS,
      },
    ]);
    await expect(service.pushToRemoteBranch(ROOT, '--force', 'main', 'main', true)).rejects.toThrow();
  });

  it('fetches only remotes tracked by local branches, skipping branches without an upstream', async () => {
    const { calls, service } = recorder();
    const result = await service.fetchTrackedBranches(
      ROOT,
      [
        trackedBranch('main', 'origin/main'),
        trackedBranch('feature/local-only', null),
        trackedBranch('hotfix', 'upstream/hotfix'),
        trackedBranch('dup', 'origin/dup'),
      ],
      [remoteGroup('origin'), remoteGroup('upstream'), remoteGroup('unused')],
    );
    expect(calls).toEqual([
      { args: ['fetch', '--prune', '--', 'origin'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
      { args: ['fetch', '--prune', '--', 'upstream'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
    ]);
    expect(result).toEqual({
      remotes: ['origin', 'upstream'],
      trackedBranches: ['main', 'hotfix', 'dup'],
      skippedBranches: ['feature/local-only'],
      fetchedRemotes: ['origin', 'upstream'],
    });
  });

  it('runs no Git command when no branch tracks a remote', async () => {
    const { calls, service } = recorder();
    const result = await service.fetchTrackedBranches(ROOT, [trackedBranch('feature/x', null)], [remoteGroup('origin')]);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ fetchedRemotes: [], skippedBranches: ['feature/x'] });
  });

  it('keeps fetching other remotes when one fails, then reports every failure', async () => {
    const { calls, service } = recorder((args) => (args.includes('origin') ? new Error('network down') : ''));
    await expect(
      service.fetchTrackedBranches(
        ROOT,
        [trackedBranch('main', 'origin/main'), trackedBranch('hotfix', 'upstream/hotfix')],
        [remoteGroup('origin'), remoteGroup('upstream')],
      ),
    ).rejects.toThrow('origin: network down');
    expect(calls.map((c) => c.args[3])).toEqual(['origin', 'upstream']);
  });

  it('refuses option-like remote names instead of passing them to git', async () => {
    const { calls, service } = recorder();
    await expect(
      service.fetchTrackedBranches(ROOT, [trackedBranch('main', '--upload-pack=evil/main')], [remoteGroup('--upload-pack=evil')]),
    ).rejects.toThrow(/start with "-"/);
    expect(calls).toEqual([]);
  });

  it('runs merge, rebase, cherry-pick and revert as non-interactive argument arrays', async () => {
    const { calls, service } = recorder();
    await service.mergeBranch(ROOT, 'feature/x');
    await service.mergeBranch(ROOT, 'origin/main');
    await service.rebaseOnto(ROOT, 'main');
    await service.cherryPickCommit(ROOT, HASH);
    await service.revertCommit(ROOT, HASH.toUpperCase());
    expect(calls).toEqual([
      { args: ['merge', '--no-edit', 'feature/x'], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
      { args: ['merge', '--no-edit', 'origin/main'], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
      { args: ['rebase', 'main'], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
      { args: ['cherry-pick', HASH], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
      { args: ['revert', '--no-edit', HASH], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    ]);
  });

  it('resets to hashes or refs with exact mixed/hard arguments and no trailing --', async () => {
    const { calls, service } = recorder();
    await service.resetCurrentBranch(ROOT, HASH.toUpperCase(), 'mixed');
    await service.resetCurrentBranch(ROOT, 'refs/heads/main', 'hard');
    expect(calls).toEqual([
      { args: ['reset', '--mixed', HASH], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
      { args: ['reset', '--hard', 'refs/heads/main'], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    ]);
  });

  it('reverts merge commits with an explicit positive mainline parent', async () => {
    const { calls, service } = recorder();
    await service.revertMergeCommit(ROOT, HASH.toUpperCase());
    await service.revertMergeCommit(ROOT, HASH, 2);
    expect(calls).toEqual([
      { args: ['revert', '--no-edit', '-m', '1', HASH], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
      { args: ['revert', '--no-edit', '-m', '2', HASH], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    ]);
  });

  it('deletes local branches with -d, or -D when forced', async () => {
    const { calls, service } = recorder();
    await service.deleteLocalBranch(ROOT, 'feature/old');
    await service.deleteLocalBranch(ROOT, 'feature/old', false);
    await service.deleteLocalBranch(ROOT, 'feature/old', true);
    expect(calls.map((c) => c.args)).toEqual([
      ['branch', '-d', 'feature/old'],
      ['branch', '-d', 'feature/old'],
      ['branch', '-D', 'feature/old'],
    ]);
  });

  it('unsets a local branch upstream without an option separator', async () => {
    const { calls, service } = recorder();
    await service.unsetBranchUpstream(ROOT, 'feature/old');
    expect(calls).toEqual([{ args: ['branch', '--unset-upstream', 'feature/old'] }]);
  });

  it('adds a validated origin remote with an option separator', async () => {
    const { calls, service } = recorder();
    await service.addRemote(ROOT, 'origin', '  git@github.com:user/repo.git  ');
    expect(calls).toEqual([{
      args: ['remote', 'add', '--', 'origin', 'git@github.com:user/repo.git'],
    }]);
  });

  it('preserves spaces in classified local remote paths', async () => {
    const { calls, service } = recorder();
    const localPath = String.raw`C:\My Projects\backup.git`;
    await service.addRemote(ROOT, 'backup', localPath);
    expect(calls).toEqual([{ args: ['remote', 'add', '--', 'backup', localPath] }]);
  });

  it('validates bare repository targets before running Git', async () => {
    const { calls, service } = recorder();
    await expect(service.initBareRepository('', 'main')).rejects.toThrow(/path/i);
    await expect(service.initBareRepository(ROOT, '--force')).rejects.toThrow(/start with/);
    expect(calls).toEqual([]);
  });

  it.each(['', '  ', '-flag', 'ext::sh -c test', 'EXT::command', 'https://example.com/a b.git', 'a\nb'])(
    'rejects unsafe remote URL %j',
    async (url) => {
      const { calls, service } = recorder();
      await expect(service.addRemote(ROOT, 'origin', url)).rejects.toThrow(/safe remote URL/);
      expect(calls).toEqual([]);
    },
  );

  it('reads and trims the raw URL for a configured remote', async () => {
    const { calls, service } = recorder(() => '  C:\\Temp\\origin.git\r\n');
    await expect(service.getRemoteRawUrl(ROOT, 'origin')).resolves.toBe('C:\\Temp\\origin.git');
    expect(calls).toEqual([{ args: ['remote', 'get-url', '--', 'origin'] }]);
  });

  it('returns null when the requested raw remote URL is unavailable', async () => {
    const missing = new GitExecutionError('missing', 'COMMAND_FAILED', 2, 'No such remote');
    await expect(recorder(() => missing).service.getRemoteRawUrl(ROOT, 'missing')).resolves.toBeNull();
  });

  it('checks out a remote branch as a new tracking branch', async () => {
    const { calls, service } = recorder();
    await service.checkoutRemoteBranch(ROOT, 'origin/feature/x', 'feature/x');
    expect(calls).toEqual([
      { args: ['checkout', '-b', 'feature/x', '--track', 'origin/feature/x'], timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    ]);
  });

  it.each([
    ['merge', (s: GitService) => s.mergeBranch(ROOT, '--abort')],
    ['merge with range syntax', (s: GitService) => s.mergeBranch(ROOT, 'a..b')],
    ['rebase', (s: GitService) => s.rebaseOnto(ROOT, '-i')],
    ['rebase with whitespace', (s: GitService) => s.rebaseOnto(ROOT, 'main --root')],
    ['cherry-pick of a ref', (s: GitService) => s.cherryPickCommit(ROOT, 'HEAD')],
    ['cherry-pick of a short hash', (s: GitService) => s.cherryPickCommit(ROOT, HASH.slice(0, 8))],
    ['cherry-pick option', (s: GitService) => s.cherryPickCommit(ROOT, '--abort')],
    ['revert of a ref', (s: GitService) => s.revertCommit(ROOT, 'HEAD~1')],
    ['merge revert hash', (s: GitService) => s.revertMergeCommit(ROOT, 'HEAD')],
    ['merge revert mainline', (s: GitService) => s.revertMergeCommit(ROOT, HASH, 0)],
    ['merge revert fractional mainline', (s: GitService) => s.revertMergeCommit(ROOT, HASH, 1.5)],
    ['mixed reset option injection', (s: GitService) => s.resetCurrentBranch(ROOT, '--hard', 'mixed')],
    ['hard reset option injection', (s: GitService) => s.resetCurrentBranch(ROOT, '-c', 'hard')],
    ['delete', (s: GitService) => s.deleteLocalBranch(ROOT, '-D')],
    ['delete with revision syntax', (s: GitService) => s.deleteLocalBranch(ROOT, 'main^')],
    ['tracking checkout remote', (s: GitService) => s.checkoutRemoteBranch(ROOT, '--orphan', 'x')],
    ['tracking checkout local name', (s: GitService) => s.checkoutRemoteBranch(ROOT, 'origin/x', '-f')],
    ['untrack option-like branch', (s: GitService) => s.unsetBranchUpstream(ROOT, '--unset-upstream')],
    ['add option-like remote name', (s: GitService) => s.addRemote(ROOT, '--force', 'https://example.com/a.git')],
  ])('rejects invalid input for %s before running Git', async (_label, run) => {
    const { calls, service } = recorder();
    await expect(run(service)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('runs checkout and branch creation with a trailing `--`', async () => {
    const { calls, service } = recorder();
    await service.checkoutBranch(ROOT, 'feature/x');
    await service.createBranch(ROOT, 'feature/y');
    await service.createBranch(ROOT, 'feature/z', HASH);
    await service.createBranch(ROOT, 'feature/w', 'origin/main');
    expect(calls.map((c) => c.args)).toEqual([
      ['checkout', 'feature/x', '--'],
      ['checkout', '-b', 'feature/y', '--'],
      ['checkout', '-b', 'feature/z', HASH, '--'],
      ['checkout', '-b', 'feature/w', 'origin/main', '--'],
    ]);
  });

  it('supports tracked and non-checkout branch creation argument variants', async () => {
    const { calls, service } = recorder();
    await service.createBranch(ROOT, 'from-remote', 'origin/main', { track: true });
    await service.createBranch(ROOT, 'from-local', 'main', { checkout: true, track: false });
    await service.createBranch(ROOT, 'without-checkout', 'main', { checkout: false, track: false });
    await service.createBranch(ROOT, 'tracked-no-checkout', 'origin/main', { checkout: false, track: true });
    await service.createBranch(ROOT, 'head-no-checkout', undefined, { checkout: false });
    expect(calls.map((call) => call.args)).toEqual([
      ['checkout', '-b', 'from-remote', '--track', 'origin/main'],
      ['checkout', '-b', 'from-local', '--no-track', 'main'],
      ['branch', '--no-track', 'without-checkout', 'main'],
      ['branch', '--track', 'tracked-no-checkout', 'origin/main'],
      ['branch', 'head-no-checkout'],
    ]);
    expect(calls[0]?.timeoutMs).toBe(WORKTREE_GIT_TIMEOUT_MS);
    expect(calls[1]?.timeoutMs).toBe(WORKTREE_GIT_TIMEOUT_MS);
  });

  it('implements dirty worktree inspection, safe stashing and discard', async () => {
    const { calls, service } = recorder((args) => args[0] === 'status' ? ' M a.txt\n' : '');
    await expect(service.hasWorkingTreeChanges(ROOT)).resolves.toBe(true);
    await service.stashChanges(ROOT, '  before\ncreating\x00 branch  ');
    await service.discardWorkingTreeChanges(ROOT);
    expect(calls.map((call) => call.args)).toEqual([
      ['status', '--porcelain=v1'],
      ['stash', 'push', '-u', '-m', 'before creating  branch'],
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd'],
    ]);
  });

  it('lists, applies, pops and drops only validated stash refs', async () => {
    const list = `${sha('a')}${FS}stash@{3}${FS}saved work${FS}1700000000\n`;
    const { calls, service } = recorder((args) => args[0] === 'stash' && args[1] === 'list' ? list : '');
    await expect(service.listStashes(ROOT)).resolves.toEqual([
      { index: 3, ref: 'stash@{3}', hash: sha('a'), message: 'saved work', timestamp: 1700000000 },
    ]);
    await service.applyStash(ROOT, 'stash@{3}');
    await service.popStash(ROOT, 'stash@{3}');
    await service.dropStash(ROOT, 'stash@{3}');
    expect(calls.map((call) => call.args)).toEqual([
      ['stash', 'list', '--format=%H%x1f%gd%x1f%gs%x1f%ct'],
      ['stash', 'apply', 'stash@{3}'],
      ['stash', 'pop', 'stash@{3}'],
      ['stash', 'drop', 'stash@{3}'],
    ]);
    expect(calls[1]?.timeoutMs).toBe(WORKTREE_GIT_TIMEOUT_MS);
    expect(calls[2]?.timeoutMs).toBe(WORKTREE_GIT_TIMEOUT_MS);
    const before = calls.length;
    await expect(service.applyStash(ROOT, '--all')).rejects.toThrow(/stash reference/i);
    expect(calls).toHaveLength(before);
  });

  it('pushes tracked-only or untracked stashes with an optional sanitized message', async () => {
    const { calls, service } = recorder();
    await service.stashPush(ROOT);
    await service.stashPush(ROOT, { includeUntracked: true, message: '  saved work  ' });
    expect(calls.map((call) => call.args)).toEqual([
      ['stash', 'push'],
      ['stash', 'push', '-u', '-m', 'saved work'],
    ]);
    await expect(service.stashPush(ROOT, { message: 'bad\0message' })).rejects.toThrow(/control/i);
    expect(calls).toHaveLength(2);
  });

  it('passes validated selective stash paths after -- in the required order', async () => {
    const { calls, service } = recorder();
    await service.stashPush(ROOT, {
      includeUntracked: true,
      message: 'selected work',
      paths: ['src/a b.ts', 'untracked.txt'],
    });
    expect(calls[0]?.args).toEqual([
      'stash', 'push', '-u', '-m', 'selected work', '--', 'src/a b.ts', 'untracked.txt',
    ]);
  });

  it.each(['../escape', '..\\escape', 'src/../../escape', '/absolute', String.raw`C:\absolute`, '\0bad', '-option'])(
    'rejects unsafe selective stash path %j',
    async (filePath) => {
      const { calls, service } = recorder();
      await expect(service.stashPush(ROOT, { paths: [filePath] })).rejects.toThrow(/invalid stash path/i);
      expect(calls).toEqual([]);
    },
  );

  it('resolves commit hashes and safely renames local branches', async () => {
    const { calls, service } = recorder((args) => args[0] === 'rev-parse' ? HASH.toUpperCase() : '');
    await expect(service.resolveCommitHash(ROOT, 'HEAD')).resolves.toBe(HASH);
    await expect(service.renameLocalBranch(ROOT, 'old/name', 'new/name')).resolves.toBeUndefined();
    await expect(service.renameLocalBranch(ROOT, 'same', 'same')).rejects.toThrow();
    expect(calls.map((call) => call.args)).toEqual([
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      ['branch', '-m', '--', 'old/name', 'new/name'],
    ]);
  });

  it('passes SHA-256 hashes to Git lowercased', async () => {
    const upper = 'AB'.repeat(32);
    const { calls, service } = recorder();
    const details = await service.getCommitDetails(ROOT, upper);
    await service.getFileContentAtRevision(ROOT, `${upper}^:a.txt`);
    await service.createBranch(ROOT, 'feature/sha256', upper);
    const lower = upper.toLowerCase();
    expect(details.hash).toBe(lower);
    expect(calls.map((c) => c.args)).toEqual([
      ['show', '-s', '--format=%B', lower],
      ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', '-M', '--diff-merges=first-parent', '-z', lower],
      ['show', `${lower}^:a.txt`],
      ['checkout', '-b', 'feature/sha256', lower, '--'],
    ]);
  });

  it.each([
    ['push', (s: GitService) => s.pushCurrentBranch(ROOT, '--force', false)],
    ['checkout', (s: GitService) => s.checkoutBranch(ROOT, '-f')],
    ['createBranch name', (s: GitService) => s.createBranch(ROOT, '../evil')],
    ['createBranch start point', (s: GitService) => s.createBranch(ROOT, 'ok', '--orphan')],
    ['commit details', (s: GitService) => s.getCommitDetails(ROOT, 'HEAD')],
    ['file content', (s: GitService) => s.getFileContentAtRevision(ROOT, `${HASH}:../x`)],
  ])('rejects invalid input for %s before running Git', async (_label, run) => {
    const { calls, service } = recorder();
    await expect(run(service)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('reads commit details from show and NUL-delimited diff-tree output', async () => {
    const { calls, service } = recorder((args) =>
      args[0] === 'show' ? 'Subject line\n\nBody text\n\n' : 'M\0src/a.ts\0R100\0old name.md\0new name.md\0',
    );
    await expect(service.getCommitDetails(ROOT, HASH)).resolves.toEqual({
      hash: HASH,
      body: 'Subject line\n\nBody text',
      files: [
        { status: 'M', path: 'src/a.ts' },
        { status: 'R', path: 'new name.md', oldPath: 'old name.md' },
      ],
    });
    expect(calls.map((c) => c.args)).toEqual([
      ['show', '-s', '--format=%B', HASH],
      ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', '-M', '--diff-merges=first-parent', '-z', HASH],
    ]);
  });

  it('returns "" when the file or parent revision does not exist, but rethrows other failures', async () => {
    const missing = new GitExecutionError('fatal', 'COMMAND_FAILED', 128, `fatal: invalid object name '${HASH}^'.`);
    const { calls, service } = recorder(() => missing);
    await expect(service.getFileContentAtRevision(ROOT, `${HASH}^:a.txt`)).resolves.toBe('');
    expect(calls).toEqual([{ args: ['show', `${HASH}^:a.txt`], maxStdoutBytes: 4 * 1024 * 1024 }]);

    const timeout = new GitExecutionError('timeout', 'TIMEOUT', null, '');
    await expect(recorder(() => timeout).service.getFileContentAtRevision(ROOT, `${HASH}:a.txt`)).rejects.toBe(timeout);
  });

  it('resolves the GitHub URL from origin, falling back to `git remote -v`', async () => {
    const fromOrigin = recorder(() => 'git@github.com:me/repo.git\n');
    await expect(fromOrigin.service.getGitHubRemoteUrl(ROOT)).resolves.toBe('https://github.com/me/repo');
    expect(fromOrigin.calls.map((c) => c.args)).toEqual([['remote', 'get-url', 'origin']]);

    const noOrigin = new GitExecutionError('error', 'COMMAND_FAILED', 2, "error: No such remote 'origin'");
    const fallback = recorder((args) => (args[1] === 'get-url' ? noOrigin : 'up\thttps://github.com/up/r.git (fetch)\n'));
    await expect(fallback.service.getGitHubRemoteUrl(ROOT)).resolves.toBe('https://github.com/up/r');

    const none = recorder((args) => (args[1] === 'get-url' ? 'https://gitlab.com/a/b.git' : ''));
    await expect(none.service.getGitHubRemoteUrl(ROOT)).resolves.toBeNull();
  });

  it('resolves supported remote URLs by preferred remote or verbose fallback', async () => {
    const preferred = recorder(() => 'git@bitbucket.org:team/project.git\n');
    await expect(preferred.service.getRemoteUrl(ROOT, 'upstream')).resolves.toBe(
      'git@bitbucket.org:team/project.git',
    );
    expect(preferred.calls[0].args).toEqual(['remote', 'get-url', '--', 'upstream']);

    const noOrigin = new GitExecutionError('error', 'COMMAND_FAILED', 2, "error: No such remote 'origin'");
    const fallback = recorder((args) =>
      args[1] === 'get-url'
        ? noOrigin
        : 'other\thttps://gitlab.com/team/other.git (fetch)\norigin\tgit@github.com:me/repo.git (push)\n',
    );
    await expect(fallback.service.getRemoteUrl(ROOT)).resolves.toBe('git@github.com:me/repo.git');
  });
});

describe.skipIf(!isGitAvailable())('GitService against real repositories', () => {
  const tempDirs: string[] = [];
  const service = new GitService();

  function makeTempDir(): string {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grbe-')));
    tempDirs.push(dir);
    return dir;
  }

  const git = (cwd: string, ...args: string[]): Promise<string> =>
    execGit(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], cwd);

  afterAll(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the unborn branch and no commits for an empty repository', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'trunk');

    const snapshot = await service.getRepoSnapshot(dir);
    expect(snapshot.repoRoot).toBe(path.normalize(dir));
    expect(snapshot.repoName).toBe(path.basename(dir));
    expect(snapshot.currentBranch).toBe('trunk');
    expect(snapshot.isDetachedHead).toBe(false);
    expect(snapshot.commits).toEqual([]);
    expect(snapshot.localBranches).toEqual([]);
    expect(snapshot.stashes).toEqual([]);
  });

  it('includes stashes in snapshots and supports apply and drop', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'initial\n');
    await git(dir, 'add', 'tracked.txt');
    await git(dir, 'commit', '-m', 'Initial commit');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'stashed\n');
    await service.stashChanges(dir, 'saved for later');

    const snapshot = await service.getRepoSnapshot(dir);
    expect(snapshot.stashes).toHaveLength(1);
    expect(snapshot.stashes[0]).toMatchObject({
      index: 0,
      ref: 'stash@{0}',
      message: 'On main: saved for later',
    });
    expect(snapshot.stashes[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.stashes[0]?.timestamp).toBeGreaterThan(0);

    await service.applyStash(dir, 'stash@{0}');
    expect(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('stashed\n');
    await service.dropStash(dir, 'stash@{0}');
    expect(await service.listStashes(dir)).toEqual([]);
  });

  it('reads branches, annotated tags, unicode subjects and detached HEAD', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'commit', '--allow-empty', '-m', 'Initial commit');
    await git(dir, 'tag', '-a', 'v1.0.0', '-m', 'release');
    await git(dir, 'commit', '--allow-empty', '-m', 'fix: "quoted" | piped: caf\u00e9 \u2713');
    await git(dir, 'branch', 'feature/x');

    const attached = await service.getRepoSnapshot(dir);
    expect(attached.currentBranch).toBe('main');
    expect(attached.isDetachedHead).toBe(false);
    expect(attached.localBranches.map((b) => [b.name, b.isCurrent])).toEqual([
      ['feature/x', false],
      ['main', true],
    ]);
    expect(attached.commits).toHaveLength(2);
    const [tip, root] = attached.commits;
    expect(tip.subject).toBe('fix: "quoted" | piped: caf\u00e9 \u2713');
    expect(tip.parents).toEqual([root.hash]);
    expect(root.parents).toEqual([]);
    expect(tip.refs.map((r) => r.label)).toEqual(['HEAD', 'feature/x', 'main']);
    expect(root.refs).toEqual([{ kind: 'tag', label: 'v1.0.0' }]);

    await git(dir, 'checkout', '--detach', root.hash);
    const detached = await service.getRepoSnapshot(dir);
    expect(detached.isDetachedHead).toBe(true);
    expect(detached.currentBranch).toBe(`HEAD (${root.hash.slice(0, 8)})`);
    expect(detached.localBranches.some((b) => b.isCurrent)).toBe(false);
    expect(detached.commits.find((c) => c.hash === root.hash)?.refs[0]).toEqual({ kind: 'head', label: 'HEAD' });
  });

  it('rejects with NOT_A_REPO outside a repository', async () => {
    const dir = makeTempDir();
    const error = await service.getRepoSnapshot(dir).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitExecutionError);
    expect((error as GitExecutionError).code).toBe('NOT_A_REPO');
  });

  it('reads commit details, renames, merge diffs and file contents at revisions', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a b.txt'), 'hello\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'Root commit', '-m', 'Body paragraph');
    const rootHash = (await git(dir, 'rev-parse', 'HEAD')).trim();

    await git(dir, 'checkout', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'side.txt'), 'side\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'Side change');
    await git(dir, 'checkout', 'main');
    await git(dir, 'mv', 'a b.txt', 'c d.txt');
    await git(dir, 'commit', '-m', 'Rename');
    const renameHash = (await git(dir, 'rev-parse', 'HEAD')).trim();
    await git(dir, 'merge', '--no-ff', '--no-edit', 'side');
    const mergeHash = (await git(dir, 'rev-parse', 'HEAD')).trim();

    const root = await service.getCommitDetails(dir, rootHash);
    expect(root.body).toBe('Root commit\n\nBody paragraph');
    expect(root.files).toEqual([{ status: 'A', path: 'a b.txt' }]);

    expect((await service.getCommitDetails(dir, renameHash)).files).toEqual([
      { status: 'R', path: 'c d.txt', oldPath: 'a b.txt' },
    ]);
    expect((await service.getCommitDetails(dir, mergeHash)).files).toEqual([{ status: 'A', path: 'side.txt' }]);

    expect(await service.getFileContentAtRevision(dir, `${rootHash}:a b.txt`)).toBe('hello\n');
    expect(await service.getFileContentAtRevision(dir, `${rootHash}^:a b.txt`)).toBe('');
    expect(await service.getFileContentAtRevision(dir, `${mergeHash}^:side.txt`)).toBe('');
  });

  it('creates and checks out branches', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'commit', '--allow-empty', '-m', 'one');
    const first = (await git(dir, 'rev-parse', 'HEAD')).trim();
    await git(dir, 'commit', '--allow-empty', '-m', 'two');

    await service.createBranch(dir, 'feature/from-first', first);
    expect((await git(dir, 'rev-parse', 'HEAD')).trim()).toBe(first);
    await service.checkoutBranch(dir, 'main');
    await service.createBranch(dir, 'feature/from-head');
    const snapshot = await service.getRepoSnapshot(dir);
    expect(snapshot.currentBranch).toBe('feature/from-head');
    expect(snapshot.localBranches.map((b) => b.name)).toEqual(['feature/from-first', 'feature/from-head', 'main']);
  });

  it('manages clean and dirty linked worktrees through their full lifecycle', async () => {
    const parent = makeTempDir();
    const mainRoot = path.join(parent, 'main repo');
    const cleanRoot = path.join(parent, 'linked clean worktree');
    const dirtyRoot = path.join(parent, 'linked dirty worktree');
    fs.mkdirSync(mainRoot);
    await git(mainRoot, 'init', '-b', 'main');
    fs.writeFileSync(path.join(mainRoot, 'tracked.txt'), 'initial\n');
    await git(mainRoot, 'add', 'tracked.txt');
    await git(mainRoot, 'commit', '-m', 'initial');

    await service.addWorktree(mainRoot, cleanRoot, {
      branchName: 'feature/clean',
      createBranch: true,
      startPoint: 'main',
    });

    const mixedMainRoot = process.platform === 'win32'
      ? mainRoot.replace(/^([a-z]):/i, (_match, drive: string) => `${drive.toLowerCase()}:`).replace(/\\/g, '/')
      : mainRoot;
    const mixedCleanRoot = process.platform === 'win32'
      ? cleanRoot.replace(/^([a-z]):/i, (_match, drive: string) => `${drive.toUpperCase()}:`).replace(/\\/g, '/')
      : cleanRoot;

    const fromMain = await service.listWorktrees(mixedMainRoot);
    const fromLinked = await service.listWorktrees(mixedCleanRoot);
    expect(fromMain).toHaveLength(2);
    expect(fromMain[0]).toMatchObject({ isMain: true, isCurrent: true });
    expect(path.normalize(fromMain[0].path)).toBe(path.normalize(mainRoot));
    expect(fromMain[1]).toMatchObject({ isMain: false, isCurrent: false });
    expect(path.normalize(fromMain[1].path)).toBe(path.normalize(cleanRoot));
    const mainFromLinked = fromLinked.find((worktree) => worktree.isMain);
    expect(mainFromLinked).toMatchObject({ isCurrent: false });
    expect(path.normalize(mainFromLinked?.path ?? '')).toBe(path.normalize(mainRoot));
    const cleanFromLinked = fromLinked.find((worktree) => !worktree.isMain);
    expect(cleanFromLinked).toMatchObject({ isCurrent: true, branchName: 'feature/clean' });
    expect(path.normalize(cleanFromLinked?.path ?? '')).toBe(path.normalize(cleanRoot));

    const mainSnapshot = await service.getRepoSnapshot(mixedMainRoot);
    expect(mainSnapshot.worktrees).toHaveLength(2);
    expect(mainSnapshot.worktrees.filter((worktree) => worktree.isMain && worktree.isCurrent)).toHaveLength(1);
    expect(path.normalize(
      mainSnapshot.localBranches.find((branch) => branch.name === 'feature/clean')?.worktreePath ?? '',
    )).toBe(path.normalize(cleanRoot));

    const linkedSnapshot = await service.getRepoSnapshot(mixedCleanRoot);
    expect(linkedSnapshot.worktrees.filter((worktree) => !worktree.isMain && worktree.isCurrent)).toHaveLength(1);
    const linkedBranch = linkedSnapshot.localBranches.find((branch) => branch.name === 'feature/clean');
    expect(linkedBranch).toMatchObject({ isCurrent: true });
    expect(path.normalize(linkedBranch?.worktreePath ?? '')).toBe(path.normalize(cleanRoot));

    await service.removeWorktree(mainRoot, cleanRoot);
    expect(fs.existsSync(cleanRoot)).toBe(false);
    expect((await service.listWorktrees(mainRoot))).toHaveLength(1);

    await service.addWorktree(mainRoot, dirtyRoot, {
      branchName: 'feature/dirty',
      createBranch: true,
    });
    fs.writeFileSync(path.join(dirtyRoot, 'tracked.txt'), 'dirty tracked content\n');
    fs.writeFileSync(path.join(dirtyRoot, 'untracked.txt'), 'dirty untracked content\n');

    const cleanRemoval = await service.removeWorktree(mainRoot, dirtyRoot).catch((err: unknown) => err);
    expect(cleanRemoval).toBeInstanceOf(GitExecutionError);
    expect((cleanRemoval as GitExecutionError).stderr).toMatch(/modified|untracked/i);
    expect(fs.existsSync(dirtyRoot)).toBe(true);

    await service.removeWorktree(mainRoot, dirtyRoot, true);
    expect(fs.existsSync(dirtyRoot)).toBe(false);
    expect((await service.listWorktrees(mainRoot)).every((worktree) => !worktree.branchName?.includes('dirty')))
      .toBe(true);
  });

  it('reset --mixed moves HEAD back and leaves the later file change unstaged', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Test User');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'commit.gpgsign', 'false');

    const file = path.join(dir, 'reset.txt');
    fs.writeFileSync(file, 'first\n');
    await git(dir, 'add', 'reset.txt');
    await git(dir, 'commit', '-m', 'first');
    const first = (await git(dir, 'rev-parse', 'HEAD')).trim();

    fs.writeFileSync(file, 'second\n');
    await git(dir, 'add', 'reset.txt');
    await git(dir, 'commit', '-m', 'second');

    await service.resetCurrentBranch(dir, first, 'mixed');

    expect((await git(dir, 'rev-parse', 'HEAD')).trim()).toBe(first);
    expect(fs.readFileSync(file, 'utf8')).toBe('second\n');
    expect((await git(dir, 'status', '--porcelain')).trim()).toBe('M reset.txt');
  });

  it('reset --hard moves HEAD back and discards commits and uncommitted tracked changes', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Test User');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'commit.gpgsign', 'false');

    const file = path.join(dir, 'hard-reset.txt');
    fs.writeFileSync(file, 'base\n');
    await git(dir, 'add', 'hard-reset.txt');
    await git(dir, 'commit', '-m', 'base');
    const first = (await git(dir, 'rev-parse', 'HEAD')).trim();
    await git(dir, 'tag', 'v0-base');

    fs.writeFileSync(file, 'subsequent commit\n');
    await git(dir, 'add', 'hard-reset.txt');
    await git(dir, 'commit', '-m', 'subsequent');
    fs.writeFileSync(file, 'uncommitted change\n');

    await service.resetCurrentBranch(dir, 'refs/tags/v0-base', 'hard');

    expect((await git(dir, 'rev-parse', 'HEAD')).trim()).toBe(first);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('base');
    expect((await git(dir, 'status', '--porcelain')).trim()).toBe('');
  });

  it('reverts a real merge commit with mainline 1 and preserves the first-parent change', async () => {
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Test User');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'commit.gpgsign', 'false');

    fs.writeFileSync(path.join(dir, 'main.txt'), 'main-base\n');
    await git(dir, 'add', 'main.txt');
    await git(dir, 'commit', '-m', 'main base');

    await git(dir, 'checkout', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature change\n');
    await git(dir, 'add', 'feature.txt');
    await git(dir, 'commit', '-m', 'feature change');

    await git(dir, 'checkout', 'main');
    fs.writeFileSync(path.join(dir, 'main.txt'), 'main change\n');
    await git(dir, 'add', 'main.txt');
    await git(dir, 'commit', '-m', 'main change');

    await git(dir, 'merge', '--no-ff', '--no-edit', 'feature');
    const mergeHash = (await git(dir, 'rev-parse', 'HEAD')).trim();
    expect((await git(dir, 'rev-list', '--parents', '-n', '1', mergeHash)).trim().split(' ').length).toBe(3);

    await service.revertMergeCommit(dir, mergeHash, 1);

    expect(fs.existsSync(path.join(dir, 'feature.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'main.txt'), 'utf8')).toBe('main change\n');
    expect((await git(dir, 'rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ').length).toBe(2);
    expect((await git(dir, 'log', '-1', '--format=%s')).trim()).toMatch(/^Revert "Merge branch 'feature'"/);
  });

  it('merges, rebases, cherry-picks, reverts and deletes branches', async () => {
    const dir = makeTempDir();
    // The service runs Git without the helper's -c identity flags, so give the repository its own.
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Test User');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'commit.gpgsign', 'false');

    const commitFile = async (name: string, message: string): Promise<string> => {
      fs.writeFileSync(path.join(dir, name), `${message}\n`);
      await git(dir, 'add', name);
      await git(dir, 'commit', '-m', message);
      return (await git(dir, 'rev-parse', 'HEAD')).trim();
    };
    const head = async (): Promise<string> => (await git(dir, 'rev-parse', 'HEAD')).trim();
    const subject = async (): Promise<string> => (await git(dir, 'log', '-1', '--format=%s')).trim();

    const base = await commitFile('base.txt', 'base');
    await git(dir, 'checkout', '-b', 'feature');
    await commitFile('feature.txt', 'feature work');
    await git(dir, 'checkout', 'main');
    await commitFile('main.txt', 'main work');

    // Merge: creates a two-parent commit without opening an editor.
    await service.mergeBranch(dir, 'feature');
    expect((await git(dir, 'rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')).toHaveLength(3);

    // Delete: -d succeeds for a merged branch.
    await service.deleteLocalBranch(dir, 'feature');
    expect((await service.getRepoSnapshot(dir)).localBranches.map((b) => b.name)).toEqual(['main']);

    // Delete: -d refuses an unmerged branch (and says why); force removes it.
    await git(dir, 'checkout', '-b', 'wip', base);
    const wipCommit = await commitFile('wip.txt', 'wip work');
    await git(dir, 'checkout', 'main');
    const refused = await service.deleteLocalBranch(dir, 'wip').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(GitExecutionError);
    expect((refused as GitExecutionError).stderr).toMatch(/not fully merged/i);
    await service.deleteLocalBranch(dir, 'wip', true);
    expect((await service.getRepoSnapshot(dir)).localBranches.map((b) => b.name)).toEqual(['main']);

    // Cherry-pick: replays the commit onto main (the branch is gone but the object remains).
    await service.cherryPickCommit(dir, wipCommit);
    expect(await subject()).toBe('wip work');
    expect(fs.existsSync(path.join(dir, 'wip.txt'))).toBe(true);

    // Revert: adds a revert commit that removes the change again.
    await service.revertCommit(dir, await head());
    expect(await subject()).toMatch(/^Revert "wip work"/);
    expect(fs.existsSync(path.join(dir, 'wip.txt'))).toBe(false);

    // Rebase: moves a side branch on top of main.
    await git(dir, 'checkout', '-b', 'side', base);
    await commitFile('side.txt', 'side work');
    await service.rebaseOnto(dir, 'main');
    const mainTip = (await git(dir, 'rev-parse', 'main')).trim();
    expect((await git(dir, 'rev-parse', 'HEAD~1')).trim()).toBe(mainTip);
    expect(await subject()).toBe('side work');
  });

  it('checks out a remote branch as a new local tracking branch', async () => {
    const remote = makeTempDir();
    await git(remote, 'init', '--bare', '-b', 'main');
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'commit', '--allow-empty', '-m', 'one');
    await git(dir, 'checkout', '-b', 'topic');
    await git(dir, 'commit', '--allow-empty', '-m', 'topic work');
    await git(dir, 'checkout', 'main');
    await git(dir, 'remote', 'add', 'origin', remote);
    await git(dir, 'push', 'origin', 'main', 'topic');
    await git(dir, 'branch', '-D', 'topic');

    await service.checkoutRemoteBranch(dir, 'origin/topic', 'my-topic');

    const snapshot = await service.getRepoSnapshot(dir);
    expect(snapshot.currentBranch).toBe('my-topic');
    expect(snapshot.localBranches.find((b) => b.name === 'my-topic')?.upstream).toBe('origin/topic');
  });

  it('fetches only tracked remotes and reports a deleted upstream as gone, not up to date', async () => {
    const remote = makeTempDir();
    await git(remote, 'init', '--bare', '-b', 'main');
    const dir = makeTempDir();
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'commit', '--allow-empty', '-m', 'one');
    await git(dir, 'remote', 'add', 'origin', remote);
    await git(dir, 'push', '-u', 'origin', 'main');
    await git(dir, 'checkout', '-b', 'topic');
    await git(dir, 'push', '-u', 'origin', 'topic');
    await git(dir, 'checkout', '-b', 'scratch');
    await git(dir, 'checkout', 'main');

    // Delete the upstream branch behind the repository's back, then fetch like the repository menu does.
    await execGit(['--git-dir', remote, 'branch', '-D', 'topic'], remote);
    const before = await service.getRepoSnapshot(dir);
    expect(before.localBranches.find((b) => b.name === 'topic')).toMatchObject({ upstream: 'origin/topic', upstreamGone: false });

    const result = await service.fetchTrackedBranches(dir, before.localBranches, before.remoteGroups);
    expect(result.fetchedRemotes).toEqual(['origin']);
    expect(result.skippedBranches).toEqual(['scratch']);

    const after = await service.getRepoSnapshot(dir);
    expect(after.localBranches.find((b) => b.name === 'topic')).toMatchObject({ upstream: 'origin/topic', ahead: 0, behind: 0, upstreamGone: true });
    expect(after.localBranches.find((b) => b.name === 'main')).toMatchObject({ upstreamGone: false });
    expect(after.localBranches.find((b) => b.name === 'scratch')).toMatchObject({ upstream: null, upstreamGone: false });
  });

  it('initializes a bare repository and refuses to overwrite an existing one', async () => {
    const parent = makeTempDir();
    const target = path.join(parent, 'nested', 'backup.git');
    await service.initBareRepository(target, 'main');
    expect(fs.existsSync(path.join(target, 'HEAD'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'HEAD'), 'utf8').trim()).toBe('ref: refs/heads/main');

    await expect(service.initBareRepository(target, 'other')).rejects.toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(path.join(target, 'HEAD'), 'utf8').trim()).toBe('ref: refs/heads/main');
  });
}, 60_000);
