import * as vscode from 'vscode';
import { buildGitHubCommitUrl } from '../git/gitService';
import { validateGitHubRepoName } from '../git/remoteUrlBuilder';

const GITHUB_PROVIDER_ID = 'github';
const GITHUB_SCOPES = ['repo'];
const GITHUB_PUBLISH_SCOPES = ['repo', 'read:org'];
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

export interface GitHubPublishOwner {
  readonly login: string;
  readonly type: 'user' | 'org';
}

export interface CreateGitHubRepoOptions {
  readonly ownerLogin: string;
  readonly ownerType: 'user' | 'org';
  readonly name: string;
  readonly isPrivate: boolean;
  readonly description?: string;
}

export interface CreatedGitHubRepo {
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly fullName: string;
  readonly isPrivate: boolean;
}

type FetchFn = typeof globalThis.fetch;

/**
 * Thin wrapper over VS Code's built-in GitHub authentication provider. Sessions are owned and stored
 * by VS Code's secret storage; this extension never writes tokens to disk or settings.
 */
export class GitHubService {
  constructor(private readonly fetchFn: FetchFn = globalThis.fetch) {}

  public getSession(createIfNone: boolean): Thenable<vscode.AuthenticationSession | undefined> {
    return createIfNone
      ? vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, { createIfNone: true })
      : vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, { silent: true });
  }

  public getPublishSession(): Thenable<vscode.AuthenticationSession | undefined> {
    return vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_PUBLISH_SCOPES, { createIfNone: true });
  }

  public async listPublishOwners(accessToken: string): Promise<GitHubPublishOwner[]> {
    const headers = this.apiHeaders(accessToken);
    const userResponse = await this.fetchFn(`${GITHUB_API_BASE}/user`, { method: 'GET', headers });
    if (!userResponse.ok) {
      throw await this.apiError('list the signed-in GitHub account', userResponse, accessToken);
    }
    const user = (await userResponse.json()) as { login?: unknown };
    if (typeof user.login !== 'string' || user.login.length === 0) {
      throw new Error('GitHub did not return a valid signed-in account.');
    }

    const owners: GitHubPublishOwner[] = [{ login: user.login, type: 'user' }];
    const orgResponse = await this.fetchFn(`${GITHUB_API_BASE}/user/orgs?per_page=100`, {
      method: 'GET',
      headers,
    });
    if (orgResponse.status !== 403 && orgResponse.status !== 404 && !orgResponse.ok) {
      throw await this.apiError('list GitHub organizations', orgResponse, accessToken);
    }
    if (orgResponse.ok) {
      const orgs = (await orgResponse.json()) as Array<{ login?: unknown }>;
      owners.push(
        ...orgs
          .filter((org): org is { login: string } => typeof org.login === 'string' && org.login.length > 0)
          .map((org) => ({ login: org.login, type: 'org' as const }))
          .sort((a, b) => a.login.localeCompare(b.login)),
      );
    }
    return owners;
  }

  public async createRepository(
    accessToken: string,
    options: CreateGitHubRepoOptions,
  ): Promise<CreatedGitHubRepo> {
    const nameError = validateGitHubRepoName(options.name);
    if (nameError !== null) {
      throw new Error(nameError);
    }
    if (!/^[A-Za-z0-9-]+$/.test(options.ownerLogin)) {
      throw new Error('GitHub owner login is invalid.');
    }
    const endpoint = options.ownerType === 'org'
      ? `${GITHUB_API_BASE}/orgs/${encodeURIComponent(options.ownerLogin)}/repos`
      : `${GITHUB_API_BASE}/user/repos`;
    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: this.apiHeaders(accessToken, true),
      body: JSON.stringify({
        name: options.name.trim(),
        private: options.isPrivate,
        description: options.description,
      }),
    });
    if (!response.ok) {
      throw await this.apiError(`create GitHub repository "${options.name}"`, response, accessToken);
    }
    const data = (await response.json()) as {
      clone_url?: unknown;
      html_url?: unknown;
      full_name?: unknown;
      private?: unknown;
    };
    if (
      typeof data.clone_url !== 'string' ||
      !data.clone_url.startsWith('https://github.com/') ||
      typeof data.html_url !== 'string' ||
      !data.html_url.startsWith('https://github.com/') ||
      typeof data.full_name !== 'string' ||
      typeof data.private !== 'boolean'
    ) {
      throw new Error('GitHub returned an invalid repository URL or response.');
    }
    return {
      cloneUrl: data.clone_url,
      htmlUrl: data.html_url,
      fullName: data.full_name,
      isPrivate: data.private,
    };
  }

  public async isSignedIn(): Promise<boolean> {
    return (await this.getSession(false)) !== undefined;
  }

  /** Prompts the user to sign in; returns the account label, or null if they cancelled. */
  public async signIn(): Promise<string | null> {
    try {
      const session = await this.getSession(true);
      return session?.account.label ?? null;
    } catch {
      // The user dismissed the sign-in flow.
      return null;
    }
  }

  /** Opens the commit page in the browser after validating it is a `https://github.com/` URL. */
  public async openCommit(githubRemoteUrl: string, hash: string): Promise<boolean> {
    const url = buildGitHubCommitUrl(githubRemoteUrl, hash);
    if (url === null) {
      return false;
    }
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  private apiHeaders(accessToken: string, json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'GitRepoAndBranchExplorer',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async apiError(action: string, response: Response, accessToken: string): Promise<Error> {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string') {
        detail = body.message.replaceAll(accessToken, '[redacted]');
      }
    } catch {
      // A response without JSON still receives a useful status-based message.
    }
    const suffix = response.status === 422 && /already exists/i.test(detail)
      ? ' The repository already exists.'
      : detail
        ? ` ${detail}`
        : '';
    return new Error(`Could not ${action}: GitHub returned ${response.status}.${suffix}`);
  }
}
