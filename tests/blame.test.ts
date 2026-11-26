import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { BlameCache } from '../src/git/blameCache';
import {
  escapeMarkdownText,
  formatInlineBlame,
  formatRelativeTime,
  isUncommittedHash,
  parseBlamePorcelain,
  type BlameLineInfo,
  type FileBlameMap,
} from '../src/git/blameParser';
import {
  BLAME_MAX_STDOUT_BYTES,
  BLAME_TIMEOUT_MS,
  GitBlameService,
  validateRelativeBlamePath,
} from '../src/git/gitBlameService';
import { GitExecutionError } from '../src/git/gitExecutor';
import type { GitRunner } from '../src/git/gitService';
import {
  BLAME_HOVER_ALLOWED_COMMANDS,
  BLAME_HOVER_COMMANDS,
  buildBlameHoverMarkdown,
  buildCommandUri,
} from '../src/blame/blameHover';
import {
  buildBlameGutterEntries,
  computeAgeBucket,
  formatGutterLabel,
} from '../src/blame/blameGutter';
import { resolveBlameRepository } from '../src/blame/blameRepoResolution';

const SHA1 = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const SHA1_2 = '1234567890ABCDEF1234567890ABCDEF12345678';
const SHA256 = 'A'.repeat(64);
const ZERO1 = '0'.repeat(40);
const ZERO256 = '0'.repeat(64);

describe('blame repository resolution', () => {
  it('uses the document owning repository rather than the active sidebar repository', () => {
    const requested: string[] = [];
    const coordinator = {
      getRepoRootForFile(filePath: string): string | null {
        requested.push(filePath);
        return '/repos/editor-repo';
      },
    };
    expect(resolveBlameRepository(coordinator, '/repos/editor-repo/src/file.ts')).toBe('/repos/editor-repo');
    expect(requested).toEqual(['/repos/editor-repo/src/file.ts']);
  });
});

function lineMap(entries: Array<[number, Partial<BlameLineInfo>]>): FileBlameMap {
  return new Map(entries.map(([lineNumber, value]) => [
    lineNumber,
    {
      lineNumber,
      originalLineNumber: lineNumber,
      hash: SHA1,
      shortHash: SHA1.slice(0, 8).toLowerCase(),
      isUncommitted: false,
      author: 'Ada',
      authorEmail: 'ada@example.com',
      authorTime: 1700000000,
      authorTz: '+0000',
      summary: 'A summary',
      filename: 'src/file.ts',
      ...value,
    } as BlameLineInfo,
  ]));
}

describe('blameParser porcelain', () => {
  it.each(['\n', '\r\n'])('parses multi-line line-porcelain output with %j endings', (ending) => {
    const hash = SHA1.toLowerCase();
    const output = [
      `${hash} 10 1 2`,
      'author Ada Lovelace',
      'author-mail <ada@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'summary Initial change',
      'filename src/file.ts',
      `previous ${SHA1_2.toLowerCase()} old-file.ts`,
      'content first',
      `\tfirst line`,
      `${SHA1_2.toLowerCase()} 20 2`,
      'author Grace Hopper',
      'author-mail <grace@example.com>',
      'author-time 1700000100',
      'author-tz -0400',
      'summary Second change',
      'filename src/file.ts',
      '\tsecond line',
    ].join(ending);

    const blame = parseBlamePorcelain(output);
    expect(blame.get(1)).toMatchObject({
      lineNumber: 1,
      originalLineNumber: 10,
      hash,
      shortHash: hash.slice(0, 8),
      author: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorTime: 1700000000,
      authorTz: '+0000',
      summary: 'Initial change',
      filename: 'src/file.ts',
      previousHash: SHA1_2.toLowerCase(),
      previousFilename: 'old-file.ts',
    });
    expect(blame.get(2)).toMatchObject({
      lineNumber: 2,
      originalLineNumber: 20,
      hash: SHA1_2.toLowerCase(),
      shortHash: SHA1_2.toLowerCase().slice(0, 8),
      author: 'Grace Hopper',
      authorEmail: 'grace@example.com',
    });
  });

  it('supports SHA-256 hashes and normalizes uppercase to lowercase', () => {
    const blame = parseBlamePorcelain([
      `${SHA256} 3 1`,
      'author Sha256 User',
      'author-mail <sha256@example.com>',
      'author-time 1700000000',
      'author-tz +0100',
      'summary Hash-256',
      'filename sha256.txt',
      '\tvalue',
    ].join('\n'));
    expect(blame.get(1)?.hash).toBe(SHA256.toLowerCase());
    expect(blame.get(1)?.shortHash).toBe(SHA256.toLowerCase().slice(0, 8));
  });

  it('falls back to repeated standard porcelain metadata for the same hash', () => {
    const hash = SHA1.toLowerCase();
    const output = [
      `${hash} 1 1`,
      'author Ada Lovelace',
      'author-mail <ada@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'summary Reused commit',
      'filename src/file.ts',
      '\tone',
      `${hash} 2 2`,
      '\ttwo',
    ].join('\n');
    const blame = parseBlamePorcelain(output);
    expect(blame.get(1)).toMatchObject({ author: 'Ada Lovelace', summary: 'Reused commit', filename: 'src/file.ts' });
    expect(blame.get(2)).toMatchObject({ author: 'Ada Lovelace', summary: 'Reused commit', filename: 'src/file.ts' });
  });

  it.each([ZERO1, ZERO256])('marks zero hash %j as uncommitted', (hash) => {
    expect(isUncommittedHash(hash)).toBe(true);
    const blame = parseBlamePorcelain([
      `${hash} 1 1`,
      'author No User',
      'author-mail <nobody@example.com>',
      'summary Unsaved',
      'filename src/file.ts',
      '\tchanged',
    ].join('\n'));
    expect(blame.get(1)).toMatchObject({
      hash,
      shortHash: '',
      isUncommitted: true,
      author: 'Not Committed Yet',
    });
  });

  it('returns false for ordinary commit hashes', () => {
    expect(isUncommittedHash(SHA1)).toBe(false);
    expect(isUncommittedHash(SHA256)).toBe(false);
  });

  it('safely skips malformed and truncated header blocks', () => {
    expect(parseBlamePorcelain('').size).toBe(0);
    expect(parseBlamePorcelain('not a blame header\n\torphan\n')).toBeInstanceOf(Map);
    expect(parseBlamePorcelain(`${SHA1} nope nope\n\tafter\n`).size).toBe(0);
    expect(parseBlamePorcelain(`${SHA1} 1 1\nauthor Ada\n${SHA1} 2 2\n`).size).toBe(0);
  });
});

describe('blame formatting helpers', () => {
  const NOW = 1_700_000_000_000;

  it('formats relative times including future and non-positive timestamps', () => {
    expect(formatRelativeTime(1700000000, NOW)).toBe('just now');
    expect(formatRelativeTime(1700009999, NOW)).toBe('just now');
    expect(formatRelativeTime(0, NOW)).toBe('unknown');
    expect(formatRelativeTime(-1, NOW)).toBe('unknown');
    expect(formatRelativeTime(NaN, NOW)).toBe('unknown');
  });

  it('formats minute, hour, day, month and year units with singular and plural', () => {
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 60_000)).toBe('1 min ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 3 * 60_000)).toBe('3 mins ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 3_600_000)).toBe('1 hour ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 7_200_000)).toBe('2 hours ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 86_400_000)).toBe('1 day ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 172_800_000)).toBe('2 days ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 2_592_000_000)).toBe('1 month ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 5_184_000_000)).toBe('2 months ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 31_536_000_000)).toBe('1 year ago');
    expect(formatRelativeTime(1700000000, 1700000000 * 1000 + 63_072_000_000)).toBe('2 years ago');
  });

  it('formats inline blame for uncommitted, normal and empty/long summaries', () => {
    const uncommitted = lineMap([[1, { isUncommitted: true }]]).get(1)!;
    expect(formatInlineBlame(uncommitted, NOW)).toBe('Not Committed Yet');

    const normal = lineMap([[1, { author: 'Ada', authorTime: 1700000000, summary: 'Fix bug' }]]).get(1)!;
    expect(formatInlineBlame(normal, 1700000000 * 1000 + 86_400_000)).toBe('Ada, 1 day ago • Fix bug');

    const empty = lineMap([[1, { summary: '' }]]).get(1)!;
    expect(formatInlineBlame(empty, NOW)).toBe('Ada, just now');

    const long = lineMap([[1, { summary: 'abcdefghij' }]]).get(1)!;
    expect(formatInlineBlame(long, NOW, 5)).toBe('Ada, just now • abcd…');
  });

  it('escapes Markdown and command/HTML injection text and removes CR/LF', () => {
    const escaped = escapeMarkdownText('[Click](command:workbench.action.terminal.new)\n**bold** <script>\r\nnext');
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toContain('\r');
    expect(escaped).toContain('\\[Click\\]');
    expect(escaped).toContain('\\*\\*bold\\*\\*');
    expect(escaped).toContain('\\<script\\>');
  });
});

describe('blame gutter rendering', () => {
  const NOW = 1_700_000_000_000;

  describe('computeAgeBucket', () => {
    it('returns uncommitted for uncommitted, non-positive and NaN timestamps', () => {
      expect(computeAgeBucket(1700000000, 1600000000, 1800000000, true)).toBe('uncommitted');
      expect(computeAgeBucket(0, 1600000000, 1800000000, false)).toBe('uncommitted');
      expect(computeAgeBucket(-1, 1600000000, 1800000000, false)).toBe('uncommitted');
      expect(computeAgeBucket(Number.NaN, 1600000000, 1800000000, false)).toBe('uncommitted');
    });

    it('returns age0 for single-commit files and reversed ranges', () => {
      expect(computeAgeBucket(1700000000, 1700000000, 1700000000, false)).toBe('age0');
      expect(computeAgeBucket(1700000000, 1800000000, 1600000000, false)).toBe('age0');
    });

    it('maps newest and oldest commits to age0 and age4', () => {
      expect(computeAgeBucket(1800, 1000, 1800, false)).toBe('age0');
      expect(computeAgeBucket(1000, 1000, 1800, false)).toBe('age4');
    });

    it('maps intermediate timestamps monotonically across age1, age2 and age3', () => {
      const buckets = [1001, 1201, 1401, 1601].map((time) =>
        computeAgeBucket(time, 1000, 1800, false),
      );
      expect(buckets).toEqual(['age4', 'age3', 'age2', 'age1']);
      const bucketOrder = ['age0', 'age1', 'age2', 'age3', 'age4'];
      const indexes = buckets.map((bucket) => bucketOrder.indexOf(bucket));
      expect(indexes).toEqual([4, 3, 2, 1]);
    });
  });

  describe('formatGutterLabel', () => {
    const committed = (overrides: Partial<BlameLineInfo> = {}): BlameLineInfo => lineMap([[1, {
      isUncommitted: false,
      shortHash: 'abcdef12',
      author: 'Ada Lovelace',
      authorTime: 1700000000,
      ...overrides,
    }]]).get(1)!;

    it('always returns an exact fixed width and clamps widths below 12', () => {
      for (const width of [-50, 0, 11, 12, 32, 80.9, Number.NaN]) {
        const result = formatGutterLabel(committed(), NOW, width);
        expect(result).toHaveLength(Math.max(12, Number.isFinite(width) ? Math.floor(width) : 32));
      }
    });

    it('uses no collapsing ASCII spaces in padding or spacing', () => {
      const label = formatGutterLabel(committed({ author: 'Ada Lovelace' }), NOW, 32);
      expect(label).not.toContain(' ');
      expect(label).toContain('\u00A0');
    });

    it('renders an exact-width uncommitted label', () => {
      const label = formatGutterLabel(committed({
        isUncommitted: true,
        author: 'Not Committed Yet',
        shortHash: '',
        authorTime: 0,
      }), NOW, 12);
      expect(label).toHaveLength(12);
      expect(label).toContain('Not');
      expect(label).not.toContain(' ');
      expect(label.slice(12)).toBe('');
    });

    it('preserves short hashes and compact age tokens while truncating long authors', () => {
      const cases = [
        [NOW - 30_000, 'now'],
        [NOW - 5 * 60_000, '5m'],
        [NOW - 3 * 3_600_000, '3h'],
        [NOW - 4 * 86_400_000, '4d'],
        [NOW - 2 * 2_592_000_000, '2mo'],
        [NOW - 31_536_000_000, '1y'],
      ] as const;
      for (const [authorTime, token] of cases) {
        const label = formatGutterLabel(committed({
          shortHash: 'deadbee',
          author: 'AnExtremelyLongAuthorName',
          authorTime: authorTime / 1000,
        }), NOW, 32);
        expect(label).toContain('deadbee');
        expect(label).toContain(token);
        expect(label).toContain('…');
        expect(label).toHaveLength(32);
      }
    });
  });

  describe('buildBlameGutterEntries', () => {
    it('returns [] when totalLines is zero or negative', () => {
      expect(buildBlameGutterEntries(new Map(), 0, false, NOW)).toEqual([]);
      expect(buildBlameGutterEntries(new Map(), -10, false, NOW)).toEqual([]);
    });

    it('compresses consecutive lines by commit hash', () => {
      const map = lineMap([
        [1, { hash: SHA1, shortHash: 'abcdef12', authorTime: 1700000000 }],
        [2, { hash: SHA1, shortHash: 'abcdef12', authorTime: 1700000000 }],
        [3, { hash: SHA1, shortHash: 'abcdef12', authorTime: 1700000000 }],
      ]);
      const entries = buildBlameGutterEntries(map, 3, false, NOW, 32);
      expect(entries[0].isHunkStart).toBe(true);
      expect(entries[0].label.trim()).not.toBe('');
      for (const entry of entries.slice(1)) {
        expect(entry.isHunkStart).toBe(false);
        expect(entry.label).toBe('\u00A0'.repeat(32));
        expect(entry.label).toHaveLength(32);
        expect(entry.bucket).toBe(entries[0].bucket);
        expect(entry.info).toBe(map.get(entry.lineNumber));
      }
    });

    it('starts a new hunk whenever the commit hash changes, including uncommitted transitions', () => {
      const map = lineMap([
        [1, { hash: SHA1, shortHash: 'aaaaaaa', authorTime: 1700000000 }],
        [2, { hash: SHA1, shortHash: 'aaaaaaa', authorTime: 1700000000 }],
        [3, { hash: '0'.repeat(40), shortHash: '', isUncommitted: true, author: 'Not Committed Yet', authorTime: 0 }],
        [4, { hash: SHA1_2, shortHash: 'bbbbbbb', authorTime: 1690000000 }],
        [5, { hash: SHA1_2, shortHash: 'bbbbbbb', authorTime: 1690000000 }],
      ]);
      const entries = buildBlameGutterEntries(map, 5, true, NOW, 32);
      expect(entries.map((entry) => entry.isHunkStart)).toEqual([true, false, true, true, false]);
      expect(entries[2].bucket).toBe('uncommitted');
      expect(entries[2].label).toContain('Not');
    });

    it('synthesizes uncommitted info for missing dirty-buffer lines', () => {
      const map = lineMap([[1, { hash: SHA1, shortHash: 'abcdef12', authorTime: 1700000000 }]]);
      const entries = buildBlameGutterEntries(map, 4, true, NOW, 32);
      expect(entries).toHaveLength(4);
      expect(entries[1].isHunkStart).toBe(true);
      for (const entry of entries.slice(1)) {
        expect(entry.info.isUncommitted).toBe(true);
        expect(entry.info.author).toBe('Not Committed Yet');
        expect(entry.bucket).toBe('uncommitted');
      }
      expect(entries.slice(2).map((entry) => entry.isHunkStart)).toEqual([false, false]);
    });
  });
});

describe('blame hover markdown and command URIs', () => {
  const committed = lineMap([[1, {
    hash: SHA1.toLowerCase(),
    shortHash: SHA1.toLowerCase().slice(0, 8),
    isUncommitted: false,
    author: 'Ada Lovelace',
    authorTime: 1700000000,
    summary: 'Fix the parser',
  }]]).get(1)!;

  it('renders an uncommitted line with no command links', () => {
    const markdown = buildBlameHoverMarkdown({
      info: lineMap([[1, { isUncommitted: true, shortHash: '', author: 'Not Committed Yet', summary: '' }]]).get(1)!,
      repoRoot: '/repo',
      relativePath: 'src/file.ts',
    });
    expect(markdown).toContain('**Not Committed Yet**');
    expect(markdown).not.toMatch(/command:/);
  });

  it('renders committed details and exactly 3 hover actions without a GitHub remote', () => {
    const markdown = buildBlameHoverMarkdown({
      info: committed,
      repoRoot: '/repo',
      relativePath: 'src/file.ts',
      nowMs: 1700000000 * 1000 + 86_400_000,
    });
    expect(markdown).toContain(committed.shortHash);
    expect(markdown).toContain('Ada Lovelace');
    expect(markdown).toContain('1 day ago');
    expect(markdown).toContain('2023-11-14T22:13:20.000Z');
    expect(markdown).toContain('Fix the parser');
    expect(markdown.match(/command:/g)).toHaveLength(3);
    expect(markdown).toContain('[Reveal in Commit Timeline]');
    expect(markdown).toContain('[Open File Diff]');
    expect(markdown).toContain('[Copy Commit Hash]');
    expect(markdown).not.toContain('[Open on GitHub]');
  });

  it('adds the GitHub hover action when a GitHub remote is available', () => {
    const markdown = buildBlameHoverMarkdown({
      info: committed,
      repoRoot: '/repo',
      relativePath: 'src/file.ts',
      githubRemoteUrl: 'https://github.com/owner/repo',
    });
    expect(markdown.match(/command:/g)).toHaveLength(4);
    expect(markdown).toContain('[Open on GitHub]');
  });

  it('builds and round-trips clean command URIs', () => {
    const uri = buildCommandUri('gitRepoAndBranchExplorer.revealCommitInTimeline', { hash: SHA1.toLowerCase() });
    expect(uri).toBe(`command:gitRepoAndBranchExplorer.revealCommitInTimeline?${encodeURIComponent(JSON.stringify([{ hash: SHA1.toLowerCase() }]))}`);
    const suffix = uri.slice(uri.indexOf('?') + 1);
    expect(JSON.parse(decodeURIComponent(suffix))).toEqual([{ hash: SHA1.toLowerCase() }]);
  });

  it('escapes adversarial author, summary and filename text', () => {
    const malicious = '[Run](command:workbench.action.terminal.new)\n**spoof** <script>';
    const markdown = buildBlameHoverMarkdown({
      info: lineMap([[1, {
        author: malicious,
        summary: malicious,
        filename: malicious,
      }]]).get(1)!,
      repoRoot: '/repo',
      relativePath: malicious,
    });
    expect(markdown).not.toMatch(/(?<!\\)\[Run\]\(command:/);
    expect(markdown).not.toContain('\n**spoof**');
    expect(markdown).not.toContain('<script>');
  });

  it('allows only the four scoped Git blame hover commands', () => {
    expect(BLAME_HOVER_ALLOWED_COMMANDS).toEqual([
      BLAME_HOVER_COMMANDS.revealCommitInTimeline,
      BLAME_HOVER_COMMANDS.openBlameFileDiff,
      BLAME_HOVER_COMMANDS.copyCommitHash,
      BLAME_HOVER_COMMANDS.openCommitOnGitHub,
    ]);
    expect(BLAME_HOVER_ALLOWED_COMMANDS).toHaveLength(4);
  });
});

describe('BlameCache', () => {
  it('evicts the least-recently-used entry and refreshes recency on get', () => {
    const cache = new BlameCache(2);
    cache.set({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: false }, lineMap([[1, {}]]));
    cache.set({ repoRoot: '/repo', relativePath: 'b.ts', ignoreWhitespace: false }, lineMap([[2, {}]]));
    expect(cache.get({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: false })).toBeDefined();
    cache.set({ repoRoot: '/repo', relativePath: 'c.ts', ignoreWhitespace: false }, lineMap([[3, {}]]));
    expect(cache.get({ repoRoot: '/repo', relativePath: 'b.ts', ignoreWhitespace: false })).toBeUndefined();
    expect(cache.get({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: false })).toBeDefined();
    expect(cache.get({ repoRoot: '/repo', relativePath: 'c.ts', ignoreWhitespace: false })).toBeDefined();
  });

  it('normalizes Windows backslashes and trailing slashes without duplicate entries', () => {
    const cache = new BlameCache();
    const value = lineMap([[1, {}]]);
    cache.set({ repoRoot: 'C:\\Repo', relativePath: 'src\\a.ts/', ignoreWhitespace: false }, value);
    expect(cache.size).toBe(1);
    expect(cache.get({ repoRoot: 'c:/repo', relativePath: './src/a.ts', ignoreWhitespace: false })).toBe(value);
    expect(cache.get({ repoRoot: 'C:\\Repo\\', relativePath: 'src/a.ts', ignoreWhitespace: false })).toBe(value);
  });

  it('deduplicates concurrent getOrLoad calls with one loader invocation', async () => {
    const cache = new BlameCache();
    let resolveLoader!: (value: FileBlameMap) => void;
    let calls = 0;
    const promise = new Promise<FileBlameMap>((resolve) => { resolveLoader = resolve; });
    const loader = () => { calls++; return promise; };
    const key = { repoRoot: '/repo', relativePath: 'src/a.ts', ignoreWhitespace: false };
    const first = cache.getOrLoad(key, loader);
    const second = cache.getOrLoad(key, loader);
    expect(first).toBe(second);
    const value = lineMap([[1, {}]]);
    resolveLoader(value);
    await expect(first).resolves.toBe(value);
    await expect(second).resolves.toBe(value);
    expect(calls).toBe(1);
  });

  it.each(['file', 'repo', 'clear'] as const)('does not cache stale loader results after %s invalidation', async (kind) => {
    const cache = new BlameCache();
    let resolveLoader!: (value: FileBlameMap) => void;
    const promise = new Promise<FileBlameMap>((resolve) => { resolveLoader = resolve; });
    const key = { repoRoot: '/repo', relativePath: 'src/a.ts', ignoreWhitespace: false };
    const pending = cache.getOrLoad(key, () => promise);
    if (kind === 'file') cache.invalidateFile('/repo', 'src/a.ts');
    if (kind === 'repo') cache.invalidateRepo('/repo');
    if (kind === 'clear') cache.clear();
    const stale = lineMap([[1, {}]]);
    resolveLoader(stale);
    await expect(pending).resolves.toBe(stale);
    expect(cache.get(key)).toBeUndefined();
  });

  it('invalidateFile clears both whitespace modes for one file only', () => {
    const cache = new BlameCache();
    const a = lineMap([[1, {}]]);
    const b = lineMap([[2, {}]]);
    cache.set({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: false }, a);
    cache.set({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: true }, a);
    cache.set({ repoRoot: '/repo', relativePath: 'b.ts', ignoreWhitespace: false }, b);
    cache.invalidateFile('/repo', 'a.ts');
    expect(cache.get({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: false })).toBeUndefined();
    expect(cache.get({ repoRoot: '/repo', relativePath: 'a.ts', ignoreWhitespace: true })).toBeUndefined();
    expect(cache.get({ repoRoot: '/repo', relativePath: 'b.ts', ignoreWhitespace: false })).toBe(b);
  });

  it('invalidateRepo clears only entries belonging to that repository', () => {
    const cache = new BlameCache();
    const a = lineMap([[1, {}]]);
    const b = lineMap([[2, {}]]);
    cache.set({ repoRoot: '/repo-a', relativePath: 'a.ts', ignoreWhitespace: false }, a);
    cache.set({ repoRoot: '/repo-b', relativePath: 'b.ts', ignoreWhitespace: false }, b);
    cache.invalidateRepo('/repo-a');
    expect(cache.get({ repoRoot: '/repo-a', relativePath: 'a.ts', ignoreWhitespace: false })).toBeUndefined();
    expect(cache.get({ repoRoot: '/repo-b', relativePath: 'b.ts', ignoreWhitespace: false })).toBe(b);
  });
});

describe('GitBlameService validation and fake runner', () => {
  it('normalizes safe repository-relative paths', () => {
    expect(validateRelativeBlamePath('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(validateRelativeBlamePath('./src/a.ts')).toBe('src/a.ts');
  });

  it.each([
    '',
    '../secret',
    'src/../../secret',
    '/secret',
    'C:/foo.ts',
    'bad\x00name',
    'bad\nname',
    'x'.repeat(4097),
  ])('rejects unsafe relative path %j', (value) => {
    expect(() => validateRelativeBlamePath(value)).toThrow(/Blame path/);
  });

  it('passes exact blame CLI arguments and options', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string; options: unknown }> = [];
    const runner: GitRunner = async (args, cwd, options) => {
      calls.push({ args, cwd, options });
      return '';
    };
    const service = new GitBlameService(runner);
    await service.getFileBlame('/repo', 'src/file.ts');
    await service.getFileBlame('/repo', 'src/file.ts', { ignoreWhitespace: true });
    await service.getFileBlame('/repo', '-flag.ts');
    expect(calls).toEqual([
      { args: ['blame', '--line-porcelain', '--', 'src/file.ts'], cwd: '/repo', options: { timeoutMs: BLAME_TIMEOUT_MS, maxStdoutBytes: BLAME_MAX_STDOUT_BYTES } },
      { args: ['blame', '--line-porcelain', '-w', '--', 'src/file.ts'], cwd: '/repo', options: { timeoutMs: BLAME_TIMEOUT_MS, maxStdoutBytes: BLAME_MAX_STDOUT_BYTES } },
      { args: ['blame', '--line-porcelain', '--', '-flag.ts'], cwd: '/repo', options: { timeoutMs: BLAME_TIMEOUT_MS, maxStdoutBytes: BLAME_MAX_STDOUT_BYTES } },
    ]);
  });

  it.each([
    new GitExecutionError('missing repo', 'NOT_A_REPO', 128, ''),
    new GitExecutionError('timeout', 'TIMEOUT', null, ''),
    new GitExecutionError('limit', 'COMMAND_FAILED', null, '', true),
    new GitExecutionError('untracked', 'COMMAND_FAILED', 128, 'fatal: no such path in HEAD'),
  ])('gracefully returns null for GitExecutionError %#', async (error) => {
    const runner: GitRunner = async () => { throw error; };
    await expect(new GitBlameService(runner).getFileBlame('/repo', 'src/file.ts')).resolves.toBeNull();
  });

  it('gracefully returns null for untracked and no-such-path diagnostics', async () => {
    for (const stderr of [
      'fatal: no such path in HEAD',
      'fatal: pathspec did not match any files',
      'fatal: untracked file is ignored',
    ]) {
      const runner: GitRunner = async () => {
        throw new GitExecutionError('failed', 'COMMAND_FAILED', 128, stderr);
      };
      await expect(new GitBlameService(runner).getFileBlame('/repo', 'missing.ts')).resolves.toBeNull();
    }
  });

  it('rethrows other GitExecutionError failures', async () => {
    const error = new GitExecutionError('permission denied', 'COMMAND_FAILED', 128, 'permission denied');
    const runner: GitRunner = async () => { throw error; };
    await expect(new GitBlameService(runner).getFileBlame('/repo', 'src/file.ts')).rejects.toBe(error);
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

describe.skipIf(!isGitAvailable())('GitBlameService against real temporary Git repositories', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'grbe-blame-')));
    tempDirs.push(dir);
    return dir;
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [
      '-c', 'user.name=Test User',
      '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd, encoding: 'utf8', windowsHide: true }).trim();
  }

  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blames a renamed, multiply-authored tracked file and caches the second lookup', async () => {
    const dir = makeTempDir();
    git(dir, 'init', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'first line\nsecond line\n');
    git(dir, 'add', 'old.txt');
    git(dir, '-c', 'user.name=Alice Author', '-c', 'user.email=alice@example.com', 'commit', '-m', 'Initial blame commit');
    git(dir, 'mv', 'old.txt', 'src-file.ts');
    fs.appendFileSync(path.join(dir, 'src-file.ts'), 'third line\n');
    git(dir, 'add', 'src-file.ts');
    git(dir, '-c', 'user.name=Bob Author', '-c', 'user.email=bob@example.com', 'commit', '-m', 'Rename and add third line');

    const service = new GitBlameService();
    const first = await service.getFileBlame(dir, 'src-file.ts');
    expect(first).not.toBeNull();
    expect([...first!.values()].length).toBeGreaterThanOrEqual(3);
    for (const line of first!.values()) {
      expect(line.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(line.shortHash).toBe(line.hash.slice(0, 8));
      expect(line.author.length).toBeGreaterThan(0);
      expect(line.summary.length).toBeGreaterThan(0);
    }
    expect([...first!.values()].some((line) => line.author === 'Bob Author')).toBe(true);
    expect([...first!.values()].some((line) => line.summary === 'Rename and add third line')).toBe(true);

    const second = await service.getFileBlame(dir, 'src-file.ts');
    expect(second).toBe(first);
  });

  it('returns null cleanly for an untracked file in a tracked repository', async () => {
    const dir = makeTempDir();
    git(dir, 'init', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n');
    git(dir, 'add', 'tracked.txt');
    git(dir, 'commit', '-m', 'Tracked file');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'not committed\n');

    const service = new GitBlameService();
    await expect(service.getFileBlame(dir, 'untracked.txt')).resolves.toBeNull();
  });
});
