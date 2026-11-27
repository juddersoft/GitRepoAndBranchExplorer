import { describe, expect, it, vi } from 'vitest';
import { CloneDiscoveryService } from '../src/git/cloneDiscoveryService';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloneDiscoveryService', () => {
  it('lists and paginates GitHub repositories with security headers', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => {
      if (i === 0) return { full_name: 'owner/good', clone_url: 'https://github.com/owner/good.git', private: true };
      if (i === 1) return { full_name: 'owner/bad', clone_url: 'https://evil.com/owner/bad.git' };
      if (i === 99) return { clone_url: 'https://github.com/owner/missing.git' };
      return { full_name: `owner/repo-${i}`, clone_url: `https://github.com/owner/repo-${i}.git` };
    });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([
        { full_name: 'owner/two', clone_url: 'https://github.com/owner/two.git', default_branch: 'main' },
      ]));
    const service = new CloneDiscoveryService(fetchFn as typeof globalThis.fetch);

    const repos = await service.listGitHubRepos('secret-token', 3);

    expect(repos.map((repo) => repo.fullName)).toEqual([
      'owner/good',
      ...Array.from({ length: 97 }, (_, i) => `owner/repo-${i + 2}`),
      'owner/two',
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer secret-token',
        'X-GitHub-Api-Version': '2026-03-10',
      }),
    }));
  });

  it('paginates 100-item pages until maxPages', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      full_name: `owner/repo-${i}`,
      clone_url: `https://github.com/owner/repo-${i}.git`,
    }));
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(page));
    const service = new CloneDiscoveryService(fetchFn as typeof globalThis.fetch);
    const repos = await service.listGitHubRepos('token', 2);
    expect(repos).toHaveLength(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('uses GitHub Enterprise Cloud and GHES API endpoints', async () => {
    const cloudFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    await new CloneDiscoveryService(cloudFetch as typeof globalThis.fetch)
      .listGitHubEnterpriseRepos('https://acme.ghe.com', 'token');
    expect(cloudFetch.mock.calls[0][0]).toContain('https://api.acme.ghe.com/user/repos');

    const serverFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    await new CloneDiscoveryService(serverFetch as typeof globalThis.fetch)
      .listGitHubEnterpriseRepos('https://git.corp.example.com', 'token');
    expect(serverFetch.mock.calls[0][0]).toContain('https://git.corp.example.com/api/v3/user/repos');
  });

  it('filters Enterprise repositories by the exact web base and rejects invalid URIs', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse([
      { full_name: 'acme/good', clone_url: 'https://acme.ghe.com/acme/good.git' },
      { full_name: 'acme/spoof', clone_url: 'https://evil.com/acme/spoof.git' },
      { clone_url: 'https://acme.ghe.com/acme/missing.git' },
    ]));
    const service = new CloneDiscoveryService(fetchFn as typeof globalThis.fetch);
    const repos = await service.listGitHubEnterpriseRepos('https://acme.ghe.com', 'token');
    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/good']);

    fetchFn.mockClear();
    await expect(service.listGitHubEnterpriseRepos('http://acme.ghe.com', 'token'))
      .rejects.toThrow('valid GitHub Enterprise HTTPS URL');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('lists valid Azure DevOps organizations', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'profile-id' }))
      .mockResolvedValueOnce(jsonResponse({ value: [
        { accountName: 'acme', accountUri: 'https://dev.azure.com/acme/' },
        { accountName: '../evil', accountUri: 'https://evil.example/acme' },
        { accountName: 'spoof', accountUri: 'https://evil.example/spoof' },
        { accountName: 'missingUri' },
      ] }));
    const service = new CloneDiscoveryService(fetchFn as typeof globalThis.fetch);
    expect(await service.listAzureDevOpsOrganizations('token')).toEqual([
      { accountName: 'acme', accountUri: 'https://dev.azure.com/acme/' },
    ]);
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
    );
    expect(fetchFn.mock.calls[1][0]).toBe(
      'https://app.vssps.visualstudio.com/_apis/accounts?memberId=profile-id&api-version=7.1',
    );
  });

  it('rejects invalid Azure organization names', async () => {
    for (const name of ['../evil', 'bad org', 'bad/org', '-bad']) {
      const fetchFn = vi.fn();
      await expect(new CloneDiscoveryService(fetchFn as typeof globalThis.fetch).listAzureDevOpsRepos(name, 'token'))
        .rejects.toThrow('organization name is invalid');
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it('filters disabled and spoofed Azure DevOps repositories', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ value: [
      {
        name: 'repo',
        isDisabled: false,
        project: { name: 'Project' },
        remoteUrl: 'https://dev.azure.com/acme/Project/_git/repo',
        defaultBranch: 'refs/heads/main',
      },
      {
        name: 'old',
        isDisabled: true,
        project: { name: 'Project' },
        remoteUrl: 'https://dev.azure.com/acme/Project/_git/old',
      },
      {
        name: 'spoof',
        project: { name: 'Project' },
        remoteUrl: 'https://evil.visualstudio.com/Project/_git/spoof',
      },
    ] }));
    const repos = await new CloneDiscoveryService(fetchFn as typeof globalThis.fetch)
      .listAzureDevOpsRepos('acme', 'token');
    expect(repos).toEqual([{
      provider: 'azureDevOps',
      fullName: 'Project/repo',
      cloneUrl: 'https://dev.azure.com/acme/Project/_git/repo',
      projectName: 'Project',
      defaultBranch: 'refs/heads/main',
    }]);
  });

  it('accepts legacy Azure organization clone URLs', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ value: [
      {
        name: 'repo',
        project: { name: 'Project' },
        remoteUrl: 'https://acme.visualstudio.com/Project/_git/repo',
      },
    ] }));
    const repos = await new CloneDiscoveryService(fetchFn as typeof globalThis.fetch)
      .listAzureDevOpsRepos('acme', 'token');
    expect(repos[0].cloneUrl).toBe('https://acme.visualstudio.com/Project/_git/repo');
  });

  it.each([401, 403, 500])('never leaks bearer tokens from HTTP %i errors', async (status) => {
    const token = 'super-secret-token';
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ message: `echo ${token}` }, status));
    const service = new CloneDiscoveryService(fetchFn as typeof globalThis.fetch);
    const err = await service.listGitHubRepos(token).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(token);
  });
});
