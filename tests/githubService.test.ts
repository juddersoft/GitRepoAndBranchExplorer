import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  authentication: { getSession: vi.fn() },
  env: { openExternal: vi.fn() },
  Uri: { parse: vi.fn() },
}));

import { GitHubService } from '../src/github/githubService';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GitHubService publishing', () => {
  it('lists the personal owner first and sorts organizations', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return jsonResponse({ login: 'alice' });
      }
      return jsonResponse([{ login: 'zeta' }, { login: 'acme' }]);
    }) as unknown as typeof fetch;
    const service = new GitHubService(fetchFn);

    await expect(service.listPublishOwners('secret-token')).resolves.toEqual([
      { login: 'alice', type: 'user' },
      { login: 'acme', type: 'org' },
      { login: 'zeta', type: 'org' },
    ]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'GitRepoAndBranchExplorer',
        }),
      }),
    );
  });

  it.each([403, 404])('keeps the personal owner when organization listing returns %s', async (status) => {
    const fetchFn = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/user')
        ? jsonResponse({ login: 'alice' })
        : jsonResponse({ message: 'not available' }, status),
    ) as unknown as typeof fetch;

    await expect(new GitHubService(fetchFn).listPublishOwners('token')).resolves.toEqual([
      { login: 'alice', type: 'user' },
    ]);
  });

  it.each([
    ['user' as const, 'https://api.github.com/user/repos'],
    ['org' as const, 'https://api.github.com/orgs/acme/repos'],
  ])('creates a %s repository through the correct endpoint', async (ownerType, endpoint) => {
    const fetchFn = vi.fn(async () => jsonResponse({
      clone_url: 'https://github.com/acme/project.git',
      html_url: 'https://github.com/acme/project',
      full_name: 'acme/project',
      private: true,
    })) as unknown as typeof fetch;
    const service = new GitHubService(fetchFn);

    await expect(service.createRepository('token', {
      ownerLogin: 'acme',
      ownerType,
      name: 'project',
      isPrivate: true,
      description: 'Created by extension',
    })).resolves.toEqual({
      cloneUrl: 'https://github.com/acme/project.git',
      htmlUrl: 'https://github.com/acme/project',
      fullName: 'acme/project',
      isPrivate: true,
    });
    expect(fetchFn).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
      }),
      body: JSON.stringify({
        name: 'project',
        private: true,
        description: 'Created by extension',
      }),
    }));
  });

  it('rejects non-GitHub HTTPS repository URLs', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({
      clone_url: 'https://evil.example/acme/project.git',
      html_url: 'https://github.com/acme/project',
      full_name: 'acme/project',
      private: false,
    })) as unknown as typeof fetch;

    await expect(new GitHubService(fetchFn).createRepository('token', {
      ownerLogin: 'acme',
      ownerType: 'user',
      name: 'project',
      isPrivate: false,
    })).rejects.toThrow(/invalid repository URL/i);
  });

  it('reports 422 errors clearly without leaking the token', async () => {
    const token = 'super-secret-token';
    const fetchFn = vi.fn(async () =>
      jsonResponse({ message: `Repository already exists for ${token}` }, 422),
    ) as unknown as typeof fetch;

    const error = await new GitHubService(fetchFn).createRepository(token, {
      ownerLogin: 'acme',
      ownerType: 'user',
      name: 'project',
      isPrivate: false,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/already exists/i);
    expect((error as Error).message).not.toContain(token);
  });
});
