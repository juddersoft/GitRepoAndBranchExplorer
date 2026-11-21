import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateGitRef } from '../src/git/gitExecutor';
import { buildGitHubCommitUrl, buildRefMap, isValidCommitHash, parseForEachRefOutput, parseGitLogOutput } from '../src/git/gitService';
import { isExtensionToWebviewMessage, isValidWebviewMessage, isWebviewToExtensionMessage } from '../src/types/messages';
import { buildCspHeader, getNonce } from '../src/webview/security';

const FS = '\x1f';
const RS = '\x1e';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const HOSTILE_STRINGS = [
  '<script>alert(1)</script>',
  '<img src=x onerror="globalThis.__pwned = true">',
  '$(whoami)',
  '`rm -rf /`',
  '"; DROP TABLE users; --',
  "'; exec xp_cmdshell 'dir' --",
  '${process.exit(1)}',
  '{{constructor.constructor("return process")()}}',
] as const;

describe('validateGitRef rejects hostile refs', () => {
  it.each([
    ['option injection', '--upload-pack=evil'],
    ['option injection', '--exec=/bin/sh'],
    ['config option', '-c'],
    ['force flag', '-f'],
    ['path traversal', '../../HEAD'],
    ['embedded traversal', 'refs/heads/../secret'],
    ['null byte', 'main\x00--evil'],
    ['newline', 'main\nrm -rf /'],
    ['carriage return', 'main\r'],
    ['DEL character', 'main\x7f'],
    ['refspec glob', 'refs/heads/*'],
    ['full refspec', '+refs/heads/*:refs/remotes/origin/*'],
    ['glob ?', 'feature?'],
    ['glob class', 'feat[0-9]'],
    ['reflog syntax', 'HEAD@{1}'],
    ['ancestry ~', 'main~1'],
    ['ancestry ^', 'main^'],
    ['remote path', 'origin:main'],
    ['backslash', 'feature\\evil'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects %s: %j', (_label, ref) => {
    expect(() => validateGitRef(ref)).toThrow();
  });

  it('still accepts ordinary branch names', () => {
    expect(validateGitRef('feature/branch-6')).toBe('feature/branch-6');
    expect(validateGitRef('release/v1.0.0')).toBe('release/v1.0.0');
  });

  it('passes shell metacharacters through verbatim because git is spawned without a shell', () => {
    // `$(whoami)` is a legal ref name; execGit uses spawn() with an argv array, so it is never interpreted.
    expect(validateGitRef('$(whoami)')).toBe('$(whoami)');
  });
});

describe('buildCspHeader', () => {
  const cspSource = 'https://file+.vscode-resource.vscode-cdn.net';
  const nonce = getNonce();
  const csp = buildCspHeader(cspSource, nonce);
  const directives = new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );

  it("denies everything by default with default-src 'none'", () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
  });

  it('only allows scripts carrying the per-render nonce', () => {
    expect(directives.get('script-src')).toEqual([`'nonce-${nonce}'`]);
  });

  it("never allows 'unsafe-inline', 'unsafe-eval' or wildcard sources", () => {
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(directives.get('script-src')?.some((source) => /^(https?:|data:|blob:)/.test(source))).toBe(false);
  });

  it('restricts styles, images and fonts to the webview resource origin', () => {
    expect(directives.get('style-src')).toEqual([cspSource]);
    expect(directives.get('font-src')).toEqual([cspSource]);
    expect(directives.get('img-src')).toEqual([cspSource, 'data:']);
  });

  it("disables navigation, embedding, objects and connections", () => {
    for (const directive of ['base-uri', 'form-action', 'frame-ancestors', 'object-src', 'connect-src']) {
      expect(directives.get(directive)).toEqual(["'none'"]);
    }
  });

  it('generates a fresh 128-bit hex nonce for every render', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => getNonce()));
    expect(nonces.size).toBe(50);
    for (const n of nonces) {
      expect(n).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('adversarial external navigation guards', () => {
  const validHash = 'a'.repeat(40);

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'vscode://file/C:/Windows/System32/calc.exe',
    'https://github.com@evil.com/owner/repo.git',
    'https://evil.com/github.com/owner/repo.git',
    'https://user:pass@github.com/owner/repo.git',
  ])('rejects spoofed GitHub remote URL %s', (remoteUrl) => {
    expect(buildGitHubCommitUrl(remoteUrl, validHash)).toBeNull();
  });

  it.each(['abc123', '../../issues', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64).replace(/a/g, 'g')])(
    'rejects invalid commit identifier %s',
    (hash) => {
      expect(buildGitHubCommitUrl('https://github.com/owner/repo', hash)).toBeNull();
    },
  );
});

describe('static webview sink and Git spawning audit', () => {
  it('contains no dangerous DOM/execution sinks under src/webview/ui', () => {
    const uiRoot = path.resolve('src/webview/ui');
    const files = fs.readdirSync(uiRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => path.join(uiRoot, entry));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\.(innerHTML|outerHTML)\b/);
      expect(source, file).not.toContain('insertAdjacentHTML');
      expect(source, file).not.toContain('document.write');
      expect(source, file).not.toMatch(/\beval\s*\(/);
      expect(source, file).not.toContain('new Function');
    }
  });

  it('prepends color and ext protocol hardening to every Git spawn argv', () => {
    const source = fs.readFileSync(path.resolve('src/git/gitExecutor.ts'), 'utf8');
    expect(source).toContain("['-c', 'color.ui=false', '-c', 'protocol.ext.allow=never', ...args]");
  });
});

describe('isValidWebviewMessage rejects hostile payloads', () => {
  afterEach(() => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects prototype-pollution keys at the message and payload level', () => {
    expect(isValidWebviewMessage(JSON.parse('{"type":"webviewReady","__proto__":{"polluted":true}}'))).toBe(false);
    expect(isValidWebviewMessage(JSON.parse('{"type":"gitAction","payload":{"__proto__":{"action":"push"}}}'))).toBe(false);
    expect(isValidWebviewMessage(JSON.parse('{"type":"gitAction","payload":{"action":"push","constructor":{"prototype":{}}}}'))).toBe(false);
    expect(isValidWebviewMessage({ type: 'requestRefresh', prototype: {} })).toBe(false);
  });

  it('rejects prototype keys and option-injection refs in inbound messages', () => {
    expect(isWebviewToExtensionMessage(JSON.parse('{"type":"checkoutBranch","payload":{"branchName":"main","__proto__":{"polluted":true}}}'))).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'checkoutBranch', payload: { branchName: '--upload-pack=calc' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'checkoutBranch', payload: { branchName: '-c' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'gitAction', payload: { action: 'merge', target: '--exec=sh' } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: 'gitAction', payload: { action: 'merge', target: 'main', constructor: true } })).toBe(false);
  });

  it('ignores inherited properties', () => {
    expect(isValidWebviewMessage(Object.create({ type: 'webviewReady' }))).toBe(false);
    const payload = Object.create({ action: 'push' }) as object;
    expect(isValidWebviewMessage({ type: 'gitAction', payload })).toBe(false);
  });

  it('rejects message types and git actions that only exist on Object.prototype', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isValidWebviewMessage({ type: name })).toBe(false);
      expect(isValidWebviewMessage({ type: 'gitAction', payload: { action: name } })).toBe(false);
    }
  });

  it('rejects invalid git action names', () => {
    for (const action of ['reset --hard', 'push --force', 'PUSH', 'fetch;rm', '', 42, null]) {
      expect(isValidWebviewMessage({ type: 'gitAction', payload: { action } })).toBe(false);
    }
  });

  it('enforces branch name length limits', () => {
    expect(isValidWebviewMessage({ type: 'checkoutBranch', payload: { branchName: 'a'.repeat(255) } })).toBe(true);
    expect(isValidWebviewMessage({ type: 'checkoutBranch', payload: { branchName: 'a'.repeat(256) } })).toBe(false);
    expect(isValidWebviewMessage({ type: 'checkoutBranch', payload: { branchName: 'x'.repeat(1_000_000) } })).toBe(false);
  });

  it('accepts SHA-1 or SHA-256 hex commit hashes in either case and nothing else', () => {
    expect(isValidWebviewMessage({ type: 'copyCommitHash', payload: { hash: SHA_A } })).toBe(true);
    expect(isValidWebviewMessage({ type: 'copyCommitHash', payload: { hash: 'c'.repeat(64) } })).toBe(true);
    expect(isValidWebviewMessage({ type: 'copyCommitHash', payload: { hash: 'A'.repeat(40) } })).toBe(true);
    for (const hash of ['g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), `${SHA_A}\n`, `${'a'.repeat(39)};`, '<script>', 'a'.repeat(10_000)]) {
      expect(isValidWebviewMessage({ type: 'copyCommitHash', payload: { hash } })).toBe(false);
    }
  });

  it('rejects malformed envelopes and payloads', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      'webviewReady',
      [],
      ['webviewReady'],
      { type: 42 },
      { type: ['webviewReady'] },
      { type: 'webviewReady', payload: 'not-an-object' },
      { type: 'webviewReady', payload: [] },
      { type: 'checkoutBranch' },
      { type: 'checkoutBranch', payload: null },
      { type: 'checkoutBranch', payload: { branchName: 42 } },
      { type: 'checkoutBranch', payload: { branchName: ['main'] } },
      { type: 'gitAction', payload: ['push'] },
      { type: 'copyCommitHash', payload: { hash: { toString: () => SHA_A } } },
    ];
    for (const value of malformed) {
      expect(isValidWebviewMessage(value)).toBe(false);
    }
  });
});

describe('Phase 5 webview message validators', () => {
  const diff = (overrides: Record<string, unknown>): unknown => ({
    type: 'openFileDiff',
    payload: { hash: SHA_A, filePath: 'src/a.ts', status: 'M', ...overrides },
  });

  it('accepts well-formed commit detail, diff, Git Graph and GitHub messages', () => {
    expect(isValidWebviewMessage({ type: 'requestCommitDetails', payload: { hash: SHA_A } })).toBe(true);
    expect(isValidWebviewMessage({ type: 'openCommitOnGitHub', payload: { hash: SHA_B } })).toBe(true);
    expect(isValidWebviewMessage({ type: 'openInGitGraph' })).toBe(true);
    expect(isValidWebviewMessage({ type: 'signInGitHub' })).toBe(true);
    expect(isValidWebviewMessage(diff({}))).toBe(true);
    expect(isValidWebviewMessage(diff({ status: 'R', filePath: 'new name.md', oldPath: 'docs/old name.md' }))).toBe(true);
    expect(isValidWebviewMessage(diff({ filePath: 'caf\u00e9/\u65e5\u672c.md' }))).toBe(true);
  });

  it('rejects non-hex or missing hashes on hash-bearing messages', () => {
    for (const type of ['requestCommitDetails', 'openCommitOnGitHub']) {
      for (const hash of ['HEAD', 'main', 'g'.repeat(40), `${SHA_A}^`, `--upload-pack=evil`, undefined, 42]) {
        expect(isValidWebviewMessage({ type, payload: { hash } })).toBe(false);
      }
      expect(isValidWebviewMessage({ type })).toBe(false);
    }
    expect(isValidWebviewMessage(diff({ hash: 'HEAD~1' }))).toBe(false);
  });

  it('agrees with GitService on SHA-1/SHA-256 hash lengths for every hash-bearing message', () => {
    const samples = ['a'.repeat(39), SHA_A, 'a'.repeat(41), 'e'.repeat(63), 'e'.repeat(64), 'e'.repeat(65), `${'e'.repeat(63)}z`];
    for (const hash of samples) {
      const expected = isValidCommitHash(hash);
      expect(expected).toBe(hash.length === 40 || hash === 'e'.repeat(64));
      expect(isValidWebviewMessage({ type: 'requestCommitDetails', payload: { hash } })).toBe(expected);
      expect(isValidWebviewMessage({ type: 'openCommitOnGitHub', payload: { hash } })).toBe(expected);
      expect(isValidWebviewMessage(diff({ hash }))).toBe(expected);
    }
  });

  it.each([
    '../secret',
    'src/../../etc/passwd',
    '..\\..\\Windows\\win.ini',
    '/etc/passwd',
    '\\\\server\\share\\x',
    'C:/Windows/win.ini',
    'a\0b',
    'a\nb',
    './a.ts',
    'a//b',
    '',
    'x'.repeat(4097),
  ])('rejects unsafe file path %j', (filePath) => {
    expect(isValidWebviewMessage(diff({ filePath }))).toBe(false);
    expect(isValidWebviewMessage(diff({ status: 'R', oldPath: filePath }))).toBe(false);
  });

  it('rejects invalid status letters and malformed diff payloads', () => {
    for (const status of ['X', 'm', 'R100', 'AM', '', 42, null, undefined, 'toString']) {
      expect(isValidWebviewMessage(diff({ status }))).toBe(false);
    }
    expect(isValidWebviewMessage(diff({ filePath: ['src/a.ts'] }))).toBe(false);
    expect(isValidWebviewMessage(diff({ oldPath: 42 }))).toBe(false);
    expect(isValidWebviewMessage({ type: 'openFileDiff' })).toBe(false);
    expect(isValidWebviewMessage({ type: 'openFileDiff', payload: [SHA_A, 'a.ts', 'M'] })).toBe(false);
    expect(isValidWebviewMessage(JSON.parse(`{"type":"openFileDiff","payload":{"hash":"${SHA_A}","filePath":"a","status":"M","__proto__":{"x":1}}}`))).toBe(false);
  });
});

describe('Phase 5 extension-to-webview message guards', () => {
  it('accepts valid commitDetails, integrationsInfo and actionStatus messages', () => {
    expect(
      isExtensionToWebviewMessage({
        type: 'commitDetails',
        payload: { hash: SHA_A, body: 'msg', files: [{ status: 'R', path: 'b', oldPath: 'a' }] },
      }),
    ).toBe(true);
    expect(
      isExtensionToWebviewMessage({
        type: 'integrationsInfo',
        payload: { gitGraphAvailable: true, gitGraphExtensionId: 'mhutchie.git-graph', githubRemoteUrl: null },
      }),
    ).toBe(true);
    expect(isExtensionToWebviewMessage({ type: 'actionStatus', payload: { busy: true, message: 'Fetching' } })).toBe(true);
    expect(isExtensionToWebviewMessage({ type: 'actionStatus', payload: { busy: false } })).toBe(true);
  });

  it('rejects malformed payloads', () => {
    const malformed: unknown[] = [
      { type: 'commitDetails', payload: { hash: SHA_A, body: 'x', files: [{ status: 'X', path: 'a' }] } },
      { type: 'commitDetails', payload: { hash: SHA_A, body: 'x', files: 'a.ts' } },
      { type: 'commitDetails', payload: { hash: SHA_A, files: [] } },
      { type: 'integrationsInfo', payload: { gitGraphAvailable: 'yes', gitGraphExtensionId: null, githubRemoteUrl: null } },
      { type: 'integrationsInfo', payload: { gitGraphAvailable: false, gitGraphExtensionId: null } },
      { type: 'actionStatus', payload: { busy: 'true' } },
      { type: 'actionStatus', payload: { busy: true, message: 'x'.repeat(501) } },
      { type: 'actionStatus' },
    ];
    for (const value of malformed) {
      expect(isExtensionToWebviewMessage(value)).toBe(false);
    }
  });
});

describe('Git parsers treat hostile strings as inert data', () => {
  afterEach(() => {
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('parseGitLogOutput preserves hostile subjects, names and emails verbatim', () => {
    const raw = HOSTILE_STRINGS.map((s, i) => {
      const hash = i.toString(16).repeat(40).slice(0, 40);
      return [hash, hash.slice(0, 7), '', s, s, s, '2024-01-01T00:00:00+00:00', '1704067200'].join(FS) + RS;
    }).join('\n');

    const commits = parseGitLogOutput(raw, new Map());

    expect(commits).toHaveLength(HOSTILE_STRINGS.length);
    commits.forEach((c, i) => {
      expect(c.subject).toBe(HOSTILE_STRINGS[i]);
      expect(c.authorName).toBe(HOSTILE_STRINGS[i]);
      expect(c.authorEmail).toBe(HOSTILE_STRINGS[i]);
    });
  });

  it('drops records whose hash is not a valid SHA instead of trusting it', () => {
    const raw = ['<script>', 'x', '', 'subject', 'n', 'e', 'd', '1'].join(FS) + RS;
    expect(parseGitLogOutput(raw, new Map())).toEqual([]);
  });

  it('parseForEachRefOutput preserves hostile ref names and attaches them as inert badges', () => {
    const script = '<script>alert(1)</script>';
    const subst = '$(whoami)';
    const sql = '"; DROP TABLE users; --';
    const raw = [
      ['*', `refs/heads/${script}`, script, SHA_A, `origin/${subst}`, '[ahead 1]', ''].join(FS),
      [' ', `refs/remotes/origin/${subst}`, `origin/${subst}`, SHA_B, '', '', ''].join(FS),
      [' ', `refs/tags/${sql}`, sql, SHA_A, '', '', ''].join(FS),
    ].join(RS) + RS;

    const refs = parseForEachRefOutput(raw);

    expect(refs.localBranches[0]).toMatchObject({ name: script, displayName: script, isCurrent: true, upstream: `origin/${subst}`, ahead: 1 });
    expect(refs.remoteGroups).toEqual([{ remoteName: 'origin', branches: [expect.objectContaining({ name: `origin/${subst}`, displayName: subst })] }]);
    expect(refs.tags).toEqual([{ name: sql, fullName: `refs/tags/${sql}`, targetHash: SHA_A }]);

    const logRaw = [SHA_A, 'aaaaaaa', '', script, sql, subst, '2024-01-01T00:00:00+00:00', '1704067200'].join(FS) + RS;
    const [commit] = parseGitLogOutput(logRaw, buildRefMap(refs, SHA_A));
    expect(commit.refs).toEqual([
      { kind: 'head', label: 'HEAD' },
      { kind: 'localBranch', label: script },
      { kind: 'tag', label: sql },
    ]);
  });

  it('does not throw on truncated or garbage input', () => {
    const garbage = ['', FS, RS, `${FS}${FS}${RS}${RS}`, '\x00\x01\x02', 'x'.repeat(100_000), `${SHA_A}${FS}${RS}`];
    for (const raw of garbage) {
      expect(() => parseGitLogOutput(raw, new Map())).not.toThrow();
      expect(() => parseForEachRefOutput(raw)).not.toThrow();
    }
  });
});
