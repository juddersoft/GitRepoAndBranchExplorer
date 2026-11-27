import { describe, expect, it } from 'vitest';
import {
  buildRemoteBranchUrl,
  buildRemoteCommitUrl,
  buildRemoteCreatePrUrl,
  buildRemoteRepoUrl,
  classifyRemoteDestination,
  encodeBranchPath,
  extractCloneFolderName,
  isDefaultBranchName,
  isUpstreamMismatchError,
  parseRemoteHostInfo,
  parseUpstreamRef,
  resolveGitHubEnterpriseApiBaseUrl,
  validateGitHubRepoName,
  validateLocalBareRepoFolderName,
  validateCloneFolderName,
  validateCloneUrl,
} from '../src/git/remoteUrlBuilder';

describe('remote destination classification', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'GitHub'],
    ['https://dev.azure.com/acme/project/_git/widgets', 'Azure DevOps'],
    ['https://gitlab.com/group/subgroup/repo.git', 'GitLab'],
    ['git@bitbucket.org:workspace/repo.git', 'Bitbucket'],
  ] as const)('classifies hosted %s', (url, providerName) => {
    expect(classifyRemoteDestination(url)).toMatchObject({
      kind: 'hosted',
      rawUrl: url,
      providerName,
      displayLabel: expect.stringContaining(`${providerName}: https://`),
    });
  });

  it.each([
    String.raw`C:\Repos\backup.git`,
    'D:/repos/backup.git',
    String.raw`\\server\share\backup.git`,
    '/srv/git/backup.git',
    './backup.git',
    '../backup.git',
    'file:///srv/git/backup.git',
  ])('classifies local path %s', (url) => {
    expect(classifyRemoteDestination(url)).toEqual({
      kind: 'localPath',
      rawUrl: url,
      displayLabel: `Local drive: ${url}`,
    });
  });

  it('keeps unrecognized destinations unchanged', () => {
    expect(classifyRemoteDestination('ssh://git@example.test/repo.git')).toEqual({
      kind: 'other',
      rawUrl: 'ssh://git@example.test/repo.git',
      displayLabel: 'ssh://git@example.test/repo.git',
    });
  });
});

describe.each([validateGitHubRepoName, validateLocalBareRepoFolderName])(
  'simple repository name validation',
  (validate) => {
    it.each(['repo', 'My_repo.v2-beta', `a${'1'.repeat(99)}`])('accepts %j', (name) => {
      expect(validate(name)).toBeNull();
    });

    it.each(['', '   ', '.', '..', 'a b', 'repo/name', `a${'1'.repeat(100)}`])('rejects %j', (name) => {
      expect(validate(name)).toEqual(expect.any(String));
    });
  },
);

describe('parseRemoteHostInfo', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'github', 'https://github.com/owner/repo', 'GitHub'],
    ['https://Acme-Corp.GHE.COM/owner/repo.git', 'github', 'https://acme-corp.ghe.com/owner/repo', 'GitHub Enterprise'],
    ['http://acme.ghe.com/owner/repo.git', 'github', 'https://acme.ghe.com/owner/repo', 'GitHub Enterprise'],
    ['git://acme.ghe.com/owner/repo', 'github', 'https://acme.ghe.com/owner/repo', 'GitHub Enterprise'],
    ['ssh://git@acme.ghe.com/owner/repo', 'github', 'https://acme.ghe.com/owner/repo', 'GitHub Enterprise'],
    ['git@acme.ghe.com:owner/repo.git', 'github', 'https://acme.ghe.com/owner/repo', 'GitHub Enterprise'],
    ['https://a.ghe.com/owner/repo', 'github', 'https://a.ghe.com/owner/repo', 'GitHub Enterprise'],
    ['ssh://git@github.com/owner/repo', 'github', 'https://github.com/owner/repo', 'GitHub'],
    ['http://github.com/owner/repo.git', 'github', 'https://github.com/owner/repo', 'GitHub'],
    ['git://github.com/owner/repo', 'github', 'https://github.com/owner/repo', 'GitHub'],
    ['https://dev.azure.com/acme/project/_git/widgets.git', 'azureDevOps', 'https://dev.azure.com/acme/project/_git/widgets', 'Azure DevOps'],
    ['https://acme@dev.azure.com/acme/project/_git/widgets', 'azureDevOps', 'https://dev.azure.com/acme/project/_git/widgets', 'Azure DevOps'],
    ['git@ssh.dev.azure.com:v3/acme/project/widgets', 'azureDevOps', 'https://dev.azure.com/acme/project/_git/widgets', 'Azure DevOps'],
    ['ssh://git@ssh.dev.azure.com/v3/acme/project/widgets', 'azureDevOps', 'https://dev.azure.com/acme/project/_git/widgets', 'Azure DevOps'],
    ['https://acme.visualstudio.com/project/_git/widgets', 'azureDevOps', 'https://dev.azure.com/acme/project/_git/widgets', 'Azure DevOps'],
    ['https://gitlab.com/group/subgroup/repo.git', 'gitlab', 'https://gitlab.com/group/subgroup/repo', 'GitLab'],
    ['git@bitbucket.org:workspace/repo.git', 'bitbucket', 'https://bitbucket.org/workspace/repo', 'Bitbucket'],
  ] as const)('normalizes %s', (raw, provider, webBaseUrl, displayName) => {
    expect(parseRemoteHostInfo(raw)).toEqual({ provider, webBaseUrl, displayName });
  });

  it.each([
    'javascript:alert(1)',
    'file:///tmp/repo',
    'https://evil.com/github.com/owner/repo',
    'https://user:password@github.com/owner/repo',
    'https://github.com/owner/..',
    'https://github.com/owner/.',
    'https://github.com/owner/repo/extra',
    'https://dev.azure.com/acme/project/not-git/repo',
    'https://other@dev.azure.com/acme/project/_git/repo',
    'https://gitlab.com/group//repo',
    'https://gitlab.com/group/../repo',
    'https://bitbucket.org/workspace/..',
    'https://github.com/owner/repo?redirect=http://evil.test',
    'https://ghe.com/owner/repo',
    'https://evil.sub.ghe.com/owner/repo',
    'https://-bad.ghe.com/owner/repo',
    'https://bad-.ghe.com/owner/repo',
    'https://acme.ghe.com.evil.com/owner/repo',
    'https://user:pass@acme.ghe.com/owner/repo',
    'https://evil.com/acme.ghe.com/owner/repo',
  ])('rejects malformed or unsafe remote %s', (raw) => {
    expect(parseRemoteHostInfo(raw)).toBeNull();
  });
});

describe('remote URL builders', () => {
  const github = parseRemoteHostInfo('https://github.com/owner/repo')!;
  const githubEnterprise = parseRemoteHostInfo('https://acme.ghe.com/owner/repo')!;
  const azure = parseRemoteHostInfo('https://dev.azure.com/org/project/_git/repo')!;
  const gitlab = parseRemoteHostInfo('https://gitlab.com/group/subgroup/repo')!;
  const bitbucket = parseRemoteHostInfo('https://bitbucket.org/workspace/repo')!;
  const sha1 = 'A'.repeat(40);
  const sha256 = 'b'.repeat(64);

  it('preserves slash-separated branch paths while encoding segments', () => {
    expect(encodeBranchPath('feature/pdj/new branch')).toBe('feature/pdj/new%20branch');
    expect(buildRemoteRepoUrl(github)).toBe('https://github.com/owner/repo');
    expect(buildRemoteBranchUrl(github, 'feature/pdj/new-branch')).toBe(
      'https://github.com/owner/repo/tree/feature/pdj/new-branch',
    );
    expect(buildRemoteBranchUrl(azure, 'feature/pdj/new-branch')).toBe(
      'https://dev.azure.com/org/project/_git/repo?version=GBfeature%2Fpdj%2Fnew-branch',
    );
    expect(buildRemoteBranchUrl(gitlab, 'feature/pdj/new-branch')).toBe(
      'https://gitlab.com/group/subgroup/repo/-/tree/feature/pdj/new-branch',
    );
    expect(buildRemoteBranchUrl(bitbucket, 'feature/pdj/new-branch')).toBe(
      'https://bitbucket.org/workspace/repo/src/feature/pdj/new-branch',
    );
  });

  it('builds provider-specific commit and PR URLs', () => {
    expect(buildRemoteCommitUrl(github, sha1)).toBe(`https://github.com/owner/repo/commit/${sha1.toLowerCase()}`);
    expect(buildRemoteCommitUrl(azure, sha256)).toBe(
      `https://dev.azure.com/org/project/_git/repo/commit/${sha256}`,
    );
    expect(buildRemoteCommitUrl(gitlab, sha1)).toBe(
      `https://gitlab.com/group/subgroup/repo/-/commit/${sha1.toLowerCase()}`,
    );
    expect(buildRemoteCommitUrl(bitbucket, sha1)).toBe(
      `https://bitbucket.org/workspace/repo/commits/${sha1.toLowerCase()}`,
    );
    expect(buildRemoteCreatePrUrl(github, 'feature/x')).toBe(
      'https://github.com/owner/repo/compare/feature/x?expand=1',
    );
    expect(buildRemoteCreatePrUrl(azure, 'feature/x')).toBe(
      'https://dev.azure.com/org/project/_git/repo/pullrequestcreate?sourceRef=feature%2Fx',
    );
    expect(buildRemoteCreatePrUrl(gitlab, 'feature/x')).toBe(
      'https://gitlab.com/group/subgroup/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx',
    );
    expect(buildRemoteCreatePrUrl(bitbucket, 'feature/x')).toBe(
      'https://bitbucket.org/workspace/repo/pull-requests/new?source=feature%2Fx',
    );
  });

  it('builds GitHub Enterprise Cloud repository, branch, commit, and PR URLs', () => {
    expect(buildRemoteRepoUrl(githubEnterprise)).toBe('https://acme.ghe.com/owner/repo');
    expect(buildRemoteBranchUrl(githubEnterprise, 'feature/x')).toBe(
      'https://acme.ghe.com/owner/repo/tree/feature/x',
    );
    expect(buildRemoteCommitUrl(githubEnterprise, sha1)).toBe(
      `https://acme.ghe.com/owner/repo/commit/${sha1.toLowerCase()}`,
    );
    expect(buildRemoteCommitUrl(githubEnterprise, sha256)).toBe(
      `https://acme.ghe.com/owner/repo/commit/${sha256}`,
    );
    expect(buildRemoteCreatePrUrl(githubEnterprise, 'feature/x')).toBe(
      'https://acme.ghe.com/owner/repo/compare/feature/x?expand=1',
    );
  });

  it('classifies GitHub Enterprise Cloud remotes with the enterprise provider name', () => {
    expect(classifyRemoteDestination('git@acme.ghe.com:owner/repo.git')).toEqual({
      kind: 'hosted',
      rawUrl: 'git@acme.ghe.com:owner/repo.git',
      displayLabel: 'GitHub Enterprise: https://acme.ghe.com/owner/repo',
      providerName: 'GitHub Enterprise',
    });
  });

  it.each(['', '..', 'feature/../main', 'feature/\nmain', 'feature//main'])('rejects unsafe branch %j', (branch) => {
    expect(buildRemoteBranchUrl(github, branch)).toBeNull();
    expect(buildRemoteCreatePrUrl(github, branch)).toBeNull();
  });

  it.each(['abc', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), `${'a'.repeat(40)}?x`])(
    'rejects invalid hash %j',
    (hash) => expect(buildRemoteCommitUrl(github, hash)).toBeNull(),
  );
});

describe('clone URL and folder validation', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'http://example.com/owner/repo.git',
    'ssh://git@example.com/owner/repo.git',
    'git@host:owner/repo.git',
    String.raw`C:\My Repos\project`,
    '/srv/git/My Repos/project',
    './local repo',
  ])('accepts valid clone URL %s', (url) => {
    expect(validateCloneUrl(url)).toMatchObject({ valid: true });
  });

  it.each([
    '',
    '   ',
    'x'.repeat(2049),
    'https://example.com/repo\nbad',
    '--upload-pack=sh -c id',
    '-u evil',
    'ext::sh -c id',
    'fd::0',
    'javascript:alert(1)',
    'data:text/plain,hi',
  ])('rejects unsafe clone URL %j', (url) => {
    expect(validateCloneUrl(url).valid).toBe(false);
  });

  it.each([
    ['https://github.com/owner/repo.git', 'repo'],
    ['https://github.com/owner/repo.git?ref=main', 'repo'],
    ['https://github.com/owner/repo.git#readme', 'repo'],
    ['git@host:org/repo.git', 'repo'],
    ['git@host:org/REPO.GIT', 'REPO'],
    [String.raw`C:\Repos\My Project\repo.git`, 'repo'],
    ['/srv/git/My Project.git/', 'My Project'],
  ])('extracts folder name from %s', (url, name) => {
    expect(extractCloneFolderName(url)).toBe(name);
  });

  it.each(['', '.', '..', '-bad', '/', '///'])(
    'falls back to repository for %j',
    (url) => expect(extractCloneFolderName(url)).toBe('repository'),
  );

  it.each(['repo', 'My Repo', 'project.v2', 'under_score'])('accepts folder name %j', (name) => {
    expect(validateCloneFolderName(name).valid).toBe(true);
  });

  it.each(['', '   ', '.', '..', '-bad', 'a/b', 'a\\b', 'bad\x00name', 'bad:name', 'bad*name', 'bad?name'])(
    'rejects folder name %j',
    (name) => expect(validateCloneFolderName(name).valid).toBe(false),
  );
});

describe('GitHub Enterprise endpoint resolution', () => {
  it('resolves GitHub Enterprise Cloud and Server hosts', () => {
    expect(resolveGitHubEnterpriseApiBaseUrl('https://acme.ghe.com')).toEqual({
      apiBaseUrl: 'https://api.acme.ghe.com',
      webBaseUrl: 'https://acme.ghe.com',
      hostname: 'acme.ghe.com',
    });
    expect(resolveGitHubEnterpriseApiBaseUrl('https://git.corp.example.com')).toEqual({
      apiBaseUrl: 'https://git.corp.example.com/api/v3',
      webBaseUrl: 'https://git.corp.example.com',
      hostname: 'git.corp.example.com',
    });
  });

  it.each([
    'http://acme.ghe.com',
    'https://github.com',
    'https://ghe.com',
    'https://user:pass@acme.ghe.com',
    'https://acme.ghe.com?x=1',
    'https://acme.ghe.com#x',
    'https://127.0.0.1',
  ])('rejects invalid Enterprise URI %s', (uri) => {
    expect(resolveGitHubEnterpriseApiBaseUrl(uri)).toBeNull();
  });
});

describe('push and upstream helpers', () => {
  it('matches the longest known remote name before the first slash fallback', () => {
    expect(parseUpstreamRef('team/origin/feature/x', ['origin', 'team/origin'])).toEqual({
      remoteName: 'team/origin',
      remoteBranch: 'feature/x',
    });
    expect(parseUpstreamRef('unknown/feature/x', ['origin'])).toEqual({
      remoteName: 'unknown',
      remoteBranch: 'feature/x',
    });
    expect(parseUpstreamRef('main', ['origin'])).toBeNull();
  });

  it('recognizes renamed-branch mismatch errors and default branches', () => {
    expect(isUpstreamMismatchError('The upstream branch of your current branch does not match the name of your current branch.')).toBe(true);
    expect(isUpstreamMismatchError('everything up-to-date')).toBe(false);
    for (const name of ['main', 'MASTER', 'develop', 'Trunk']) {
      expect(isDefaultBranchName(name)).toBe(true);
    }
    expect(isDefaultBranchName('feature/main')).toBe(false);
  });
});
