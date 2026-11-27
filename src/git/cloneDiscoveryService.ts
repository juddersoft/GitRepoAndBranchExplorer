import { resolveGitHubEnterpriseApiBaseUrl } from './remoteUrlBuilder.js';

export interface RemoteCloneRepo {
  readonly provider: 'github' | 'githubEnterprise' | 'azureDevOps';
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly description?: string;
  readonly isPrivate?: boolean;
  readonly defaultBranch?: string;
  readonly projectName?: string;
}

export interface AzureDevOpsOrg {
  readonly accountName: string;
  readonly accountUri: string;
}

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const AZURE_DEVOPS_ORGS_BASE = 'https://app.vssps.visualstudio.com';
const AZURE_DEVOPS_API_BASE = 'https://dev.azure.com';
const AZURE_DEVOPS_ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function redactSecret(value: string, secret: string): string {
  return secret.length > 0 ? value.replaceAll(secret, '[redacted]') : value;
}

export class CloneDiscoveryService {
  constructor(private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch) {}

  public async listGitHubRepos(accessToken: string, maxPages = 3): Promise<RemoteCloneRepo[]> {
    return this.listGitHubPages(
      GITHUB_API_BASE,
      'https://github.com/',
      'github',
      accessToken,
      maxPages,
    );
  }

  public async listGitHubEnterpriseRepos(
    enterpriseUri: string,
    accessToken: string,
    maxPages = 3,
  ): Promise<RemoteCloneRepo[]> {
    const endpoint = resolveGitHubEnterpriseApiBaseUrl(enterpriseUri);
    if (!endpoint) {
      throw new Error('Enter a valid GitHub Enterprise HTTPS URL without credentials, query, or fragment.');
    }
    return this.listGitHubPages(
      endpoint.apiBaseUrl,
      `${endpoint.webBaseUrl}/`,
      'githubEnterprise',
      accessToken,
      maxPages,
    );
  }

  public async listAzureDevOpsOrganizations(accessToken: string): Promise<AzureDevOpsOrg[]> {
    const profile = await this.requestJson(
      `${AZURE_DEVOPS_ORGS_BASE}/_apis/profile/profiles/me?api-version=7.1`,
      this.azureHeaders(accessToken),
      'read your Azure DevOps profile',
      accessToken,
    );
    const memberId = isRecord(profile) ? stringField(profile, 'id') : undefined;
    if (!memberId) {
      throw new Error('Azure DevOps did not return a valid profile identifier.');
    }
    const data = await this.requestJson(
      `${AZURE_DEVOPS_ORGS_BASE}/_apis/accounts?memberId=${encodeURIComponent(memberId)}&api-version=7.1`,
      this.azureHeaders(accessToken),
      'list your Azure DevOps organizations',
      accessToken,
    );
    if (!isRecord(data) || !Array.isArray(data.value)) {
      throw new Error('Azure DevOps returned an invalid organizations response.');
    }
    const organizations: AzureDevOpsOrg[] = [];
    for (const item of data.value) {
      if (!isRecord(item)) {
        continue;
      }
      const accountName = stringField(item, 'accountName');
      const accountUri = stringField(item, 'accountUri');
      if (
        accountName &&
        accountUri &&
        AZURE_DEVOPS_ORG_NAME.test(accountName) &&
        this.isValidAzureOrganizationUri(accountUri, accountName)
      ) {
        organizations.push({ accountName, accountUri });
      }
    }
    return organizations;
  }

  public async listAzureDevOpsRepos(orgName: string, accessToken: string): Promise<RemoteCloneRepo[]> {
    if (!AZURE_DEVOPS_ORG_NAME.test(orgName)) {
      throw new Error('Azure DevOps organization name is invalid.');
    }
    const data = await this.requestJson(
      `${AZURE_DEVOPS_API_BASE}/${encodeURIComponent(orgName)}/_apis/git/repositories?api-version=7.1`,
      this.azureHeaders(accessToken),
      `list repositories in Azure DevOps organization "${orgName}"`,
      accessToken,
    );
    if (!isRecord(data) || !Array.isArray(data.value)) {
      throw new Error('Azure DevOps returned an invalid repositories response.');
    }
    const repos: RemoteCloneRepo[] = [];
    for (const item of data.value) {
      if (!isRecord(item) || item.isDisabled === true || !isRecord(item.project)) {
        continue;
      }
      const name = stringField(item, 'name');
      const projectName = stringField(item.project, 'name');
      const remoteUrl = stringField(item, 'remoteUrl');
      if (!name || !projectName || !remoteUrl || !this.isValidAzureRemoteUrl(remoteUrl, orgName)) {
        continue;
      }
      repos.push({
        provider: 'azureDevOps',
        fullName: `${projectName}/${name}`,
        cloneUrl: remoteUrl,
        projectName,
        ...(typeof item.defaultBranch === 'string' && item.defaultBranch.length > 0
          ? { defaultBranch: item.defaultBranch }
          : {}),
      });
    }
    return repos;
  }

  private async listGitHubPages(
    apiBaseUrl: string,
    webBaseUrlPrefix: string,
    provider: 'github' | 'githubEnterprise',
    accessToken: string,
    maxPages: number,
  ): Promise<RemoteCloneRepo[]> {
    const repos: RemoteCloneRepo[] = [];
    const pageLimit = Number.isFinite(maxPages) ? Math.max(0, Math.floor(maxPages)) : 3;
    for (let page = 1; page <= pageLimit; page++) {
      const data = await this.requestJson(
        `${apiBaseUrl}/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member&page=${page}`,
        this.githubHeaders(accessToken),
        'list GitHub repositories',
        accessToken,
      );
      if (!Array.isArray(data)) {
        throw new Error('GitHub returned an invalid repositories response.');
      }
      for (const item of data) {
        if (!isRecord(item)) {
          continue;
        }
        const fullName = stringField(item, 'full_name');
        const cloneUrl = stringField(item, 'clone_url');
        if (!fullName || !cloneUrl || !cloneUrl.startsWith(webBaseUrlPrefix)) {
          continue;
        }
        repos.push({
          provider,
          fullName,
          cloneUrl,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(typeof item.private === 'boolean' ? { isPrivate: item.private } : {}),
          ...(typeof item.default_branch === 'string' && item.default_branch.length > 0
            ? { defaultBranch: item.default_branch }
            : {}),
        });
      }
      if (data.length < 100) {
        break;
      }
    }
    return repos;
  }

  private githubHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'GitRepoAndBranchExplorer',
    };
  }

  private azureHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
  }

  private isValidAzureRemoteUrl(remoteUrl: string, orgName: string): boolean {
    try {
      const url = new URL(remoteUrl);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.port.length === 0 &&
        (host === 'dev.azure.com' || host === `${orgName.toLowerCase()}.visualstudio.com`) &&
        (host !== 'dev.azure.com' || url.pathname.toLowerCase().startsWith(`/${orgName.toLowerCase()}/`));
    } catch {
      return false;
    }
  }

  private isValidAzureOrganizationUri(accountUri: string, orgName: string): boolean {
    try {
      const url = new URL(accountUri);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.port.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0 &&
        (host === 'dev.azure.com' || host === `${orgName.toLowerCase()}.visualstudio.com`) &&
        (host !== 'dev.azure.com' || url.pathname.toLowerCase().startsWith(`/${orgName.toLowerCase()}/`));
    } catch {
      return false;
    }
  }

  private async requestJson(
    url: string,
    headers: Record<string, string>,
    action: string,
    accessToken: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { method: 'GET', headers });
    } catch (err) {
      const detail = err instanceof Error ? redactSecret(err.message, accessToken) : 'Unknown network error';
      throw new Error(`Could not ${action}: ${detail}`);
    }
    if (!response.ok) {
      throw new Error(`Could not ${action}: provider returned HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`Could not ${action}: provider returned an invalid JSON response.`);
    }
  }
}
