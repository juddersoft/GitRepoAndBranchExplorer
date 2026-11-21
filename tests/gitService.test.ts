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
  parseUpstreamTrack,
  validateRevSpec,
  WORKTREE_GIT_TIMEOUT_MS,
} from '../src/git/gitService';
import type { RefBadge } from '../src/types/git';

const FS = '\x1f';
const RS = '\x1e';

const sha = (char: string): string => char.repeat(40);

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
    ['[ahead 1]', { ahead: 1, behind: 0 }],
    ['[behind 4]', { ahead: 0, behind: 4 }],
    ['[ahead 2, behind 5]', { ahead: 2, behind: 5 }],
    ['[gone]', { ahead: 0, behind: 0 }],
    ['', { ahead: 0, behind: 0 }],
  ])('parses %j', (track, expected) => {
    expect(parseUpstreamTrack(track)).toEqual(expected);
  });
});

describe('parseForEachRefOutput', () => {
  const raw = records(
    [' ', 'refs/heads/main', 'main', sha('a'), 'origin/main', '[behind 2]'],
    ['*', 'refs/heads/featurebranch3', 'featurebranch3', sha('b'), 'origin/featurebranch3', '[ahead 1, behind 3]'],
    [' ', 'refs/heads/local-only', 'local-only', sha('c'), '', ''],
    [' ', 'refs/remotes/upstream/main', 'upstream/main', sha('d'), '', ''],
    [' ', 'refs/remotes/origin/HEAD', 'origin', sha('a'), '', ''],
    [' ', 'refs/remotes/origin/main', 'origin/main', sha('a'), '', ''],
    [' ', 'refs/remotes/origin/featurebranch3', 'origin/featurebranch3', sha('e'), '', ''],
    [' ', 'refs/tags/v1.0.0', 'v1.0.0', sha('f'), '', ''],
    [' ', 'refs/tags/v2.0.0', 'v2.0.0', sha('1'), '', '', sha('2')],
  );
  const result = parseForEachRefOutput(raw);

  it('parses local branches with the current branch and tracking counts', () => {
    expect(result.localBranches.map((b) => b.name)).toEqual(['main', 'featurebranch3', 'local-only']);
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
    });
    expect(result.localBranches[0]).toMatchObject({ isCurrent: false, ahead: 0, behind: 2 });
    expect(result.localBranches[2]).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
  });

  it('groups remotes alphabetically and drops the symbolic origin/HEAD', () => {
    expect(result.remoteGroups.map((g) => g.remoteName)).toEqual(['origin', 'upstream']);
    const origin = result.remoteGroups[0];
    expect(origin.branches.map((b) => b.name)).toEqual(['origin/main', 'origin/featurebranch3']);
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
    });
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
    ['ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['ssh://git@github.com:22/owner/repo.git', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo'],
    ['https://user@github.com/My-Org/my.repo.git\n', 'https://github.com/My-Org/my.repo'],
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
    expect(buildGitHubCommitUrl('http://github.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://github.com.evil.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('javascript:alert(1)//https://github.com/o/r', hash)).toBeNull();
    expect(buildGitHubCommitUrl('https://github.com/o/r', 'HEAD')).toBeNull();
  });

  it('builds commit URLs for 64-character SHA-256 hashes and rejects near-miss lengths', () => {
    const sha256 = 'ABCDEF'.padEnd(64, '9');
    expect(buildGitHubCommitUrl('https://github.com/o/r', sha256)).toBe(`https://github.com/o/r/commit/${sha256.toLowerCase()}`);
    for (const length of [39, 41, 63, 65]) {
      expect(buildGitHubCommitUrl('https://github.com/o/r', 'a'.repeat(length))).toBeNull();
    }
  });
});

describe('GitService operations (fake runner)', () => {
  const ROOT = path.resolve('repo');
  const HASH = 'd'.repeat(40);

  function recorder(respond: (args: readonly string[]) => string | Error = () => ''): {
    calls: Array<{ args: readonly string[]; timeoutMs?: number }>;
    service: GitService;
  } {
    const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
    const runner: GitRunner = (args, _cwd, options) => {
      calls.push({ args, timeoutMs: options?.timeoutMs });
      const result = respond(args);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    };
    return { calls, service: new GitService(runner) };
  }

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
      { args: ['push', '-u', 'origin', 'feature/new'], timeoutMs: NETWORK_GIT_TIMEOUT_MS },
    ]);
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
    ['delete', (s: GitService) => s.deleteLocalBranch(ROOT, '-D')],
    ['delete with revision syntax', (s: GitService) => s.deleteLocalBranch(ROOT, 'main^')],
    ['tracking checkout remote', (s: GitService) => s.checkoutRemoteBranch(ROOT, '--orphan', 'x')],
    ['tracking checkout local name', (s: GitService) => s.checkoutRemoteBranch(ROOT, 'origin/x', '-f')],
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
    const { service } = recorder(() => missing);
    await expect(service.getFileContentAtRevision(ROOT, `${HASH}^:a.txt`)).resolves.toBe('');

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
}, 60_000);
