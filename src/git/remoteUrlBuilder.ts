export type RemoteProvider = 'github' | 'azureDevOps' | 'gitlab' | 'bitbucket';

export interface ParsedRemoteHost {
  readonly provider: RemoteProvider;
  readonly webBaseUrl: string;
  readonly displayName: string;
}

export type RemoteDestinationKind = 'hosted' | 'localPath' | 'other';

export interface RemoteDestinationInfo {
  readonly kind: RemoteDestinationKind;
  readonly rawUrl: string;
  readonly displayLabel: string;
  readonly providerName?: string;
}

const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const COMMIT_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function safeNameSegment(value: string): boolean {
  return NAME_SEGMENT.test(value) && value !== '.' && value !== '..';
}

function stripGitSuffix(value: string): string {
  return value.toLowerCase().endsWith('.git') ? value.slice(0, -4) : value;
}

function validPathSegments(parts: readonly string[]): boolean {
  return parts.length > 0 && parts.every((part) => part.length > 0 && !CONTROL_CHARS.test(part) && part !== '.' && part !== '..');
}

interface ParsedUrl {
  readonly host: string;
  readonly path: string[];
  readonly username: string;
  readonly password: string;
}

function parseRawRemoteUrl(rawRemoteUrl: string): ParsedUrl | null {
  const value = rawRemoteUrl.trim();
  if (value.length === 0 || CONTROL_CHARS.test(value)) {
    return null;
  }

  const scp = value.includes('://') ? null : /^(?:git@)?([^/\s@:]+):(.+)$/.exec(value);
  if (scp) {
    return { host: scp[1].toLowerCase(), path: scp[2].split('/'), username: value.startsWith('git@') ? 'git' : '', password: '' };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'git:', 'ssh:'].includes(url.protocol) || url.search.length > 0 || url.hash.length > 0) {
    return null;
  }
  const pathname = url.pathname.replace(/^\/+|\/+$/g, '');
  return {
    host: url.hostname.toLowerCase(),
    path: pathname.split('/'),
    username: url.username,
    password: url.password,
  };
}

function parsed(
  provider: RemoteProvider,
  webBaseUrl: string,
  displayName: ParsedRemoteHost['displayName'],
): ParsedRemoteHost {
  return { provider, webBaseUrl, displayName };
}

export function parseRemoteHostInfo(rawRemoteUrl: string): ParsedRemoteHost | null {
  const remote = parseRawRemoteUrl(rawRemoteUrl);
  if (!remote) {
    return null;
  }
  const lastIndex = remote.path.length - 1;
  const path = remote.path.map((part, index) => (index === lastIndex ? stripGitSuffix(part) : part));
  const hasUnsafeCredential =
    remote.password.length > 0 ||
    (remote.username.length > 0 && remote.host !== 'dev.azure.com' && remote.host !== 'ssh.dev.azure.com' && remote.host !== 'github.com' &&
      remote.host !== 'gitlab.com' && remote.host !== 'bitbucket.org');
  if (hasUnsafeCredential || (remote.username.length > 0 && remote.username !== 'git' && remote.host !== 'dev.azure.com')) {
    return null;
  }

  if (remote.host === 'github.com' && path.length === 2 && path.every(safeNameSegment)) {
    return parsed('github', `https://github.com/${path[0]}/${path[1]}`, 'GitHub');
  }

  if (remote.host === 'ssh.dev.azure.com' && path.length === 4 && path[0] === 'v3') {
    const [, org, project, repo] = path;
    if ([org, project, repo].every(safeNameSegment)) {
      return parsed('azureDevOps', `https://dev.azure.com/${org}/${project}/_git/${repo}`, 'Azure DevOps');
    }
    return null;
  }

  if (remote.host === 'dev.azure.com') {
    const parts = path;
    if (parts.length === 4 && parts[2] === '_git') {
      const [org, project, , repo] = parts;
      if (
        [org, project, repo].every(safeNameSegment) &&
        (remote.username.length === 0 || remote.username === org)
      ) {
        return parsed('azureDevOps', `https://dev.azure.com/${org}/${project}/_git/${repo}`, 'Azure DevOps');
      }
    }
    return null;
  }

  if (remote.host.endsWith('.visualstudio.com') && path.length === 3 && path[1] === '_git') {
    const org = remote.host.slice(0, -'.visualstudio.com'.length);
    const project = path[0];
    const repo = path[2];
    if ([org, project, repo].every(safeNameSegment)) {
      return parsed('azureDevOps', `https://dev.azure.com/${org}/${project}/_git/${repo}`, 'Azure DevOps');
    }
    return null;
  }

  if (remote.host === 'gitlab.com' && path.length >= 2) {
    const hasSafeSegments = path.every((part) => safeNameSegment(part) && !part.includes('\\'));
    if (hasSafeSegments) {
      return parsed('gitlab', `https://gitlab.com/${path.join('/')}`, 'GitLab');
    }
  }

  if (remote.host === 'bitbucket.org' && path.length === 2 && path.every(safeNameSegment)) {
    return parsed('bitbucket', `https://bitbucket.org/${path[0]}/${path[1]}`, 'Bitbucket');
  }
  return null;
}

function looksLikeLocalPath(rawUrl: string): boolean {
  const value = rawUrl.trim();
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^file:\/\//i.test(value)
  );
}

export function classifyRemoteDestination(rawUrl: string): RemoteDestinationInfo {
  const hosted = parseRemoteHostInfo(rawUrl);
  if (hosted) {
    return {
      kind: 'hosted',
      rawUrl,
      displayLabel: `${hosted.displayName}: ${hosted.webBaseUrl}`,
      providerName: hosted.displayName,
    };
  }
  if (looksLikeLocalPath(rawUrl)) {
    return { kind: 'localPath', rawUrl, displayLabel: `Local drive: ${rawUrl}` };
  }
  return { kind: 'other', rawUrl, displayLabel: rawUrl };
}

function validateSimpleName(name: string, kind: 'GitHub repository' | 'Local bare repository folder'): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return `${kind} name is required.`;
  }
  if (trimmed.length > 100) {
    return `${kind} name must be 100 characters or fewer.`;
  }
  if (!NAME_SEGMENT.test(trimmed)) {
    return `${kind} name can contain only letters, numbers, dots, underscores, and hyphens.`;
  }
  if (trimmed === '.' || trimmed === '..') {
    return `${kind} name cannot be "." or "..".`;
  }
  return null;
}

export function validateGitHubRepoName(name: string): string | null {
  return validateSimpleName(name, 'GitHub repository');
}

export function validateLocalBareRepoFolderName(name: string): string | null {
  return validateSimpleName(name, 'Local bare repository folder');
}

function isSafeBranchName(branchName: string): boolean {
  return branchName.length > 0 && !CONTROL_CHARS.test(branchName) && !branchName.includes('..');
}

export function encodeBranchPath(branchName: string): string {
  return branchName.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function buildRemoteRepoUrl(remote: ParsedRemoteHost): string {
  return remote.webBaseUrl;
}

export function buildRemoteBranchUrl(remote: ParsedRemoteHost, branchName: string): string | null {
  if (!isSafeBranchName(branchName) || !validPathSegments(branchName.split('/'))) {
    return null;
  }
  switch (remote.provider) {
    case 'github':
      return `${remote.webBaseUrl}/tree/${encodeBranchPath(branchName)}`;
    case 'azureDevOps':
      return `${remote.webBaseUrl}?version=GB${encodeURIComponent(branchName)}`;
    case 'gitlab':
      return `${remote.webBaseUrl}/-/tree/${encodeBranchPath(branchName)}`;
    case 'bitbucket':
      return `${remote.webBaseUrl}/src/${encodeBranchPath(branchName)}`;
  }
}

export function buildRemoteCommitUrl(remote: ParsedRemoteHost, hash: string): string | null {
  if (!COMMIT_HASH.test(hash)) {
    return null;
  }
  const normalized = hash.toLowerCase();
  switch (remote.provider) {
    case 'github':
      return `${remote.webBaseUrl}/commit/${normalized}`;
    case 'azureDevOps':
      return `${remote.webBaseUrl}/commit/${normalized}`;
    case 'gitlab':
      return `${remote.webBaseUrl}/-/commit/${normalized}`;
    case 'bitbucket':
      return `${remote.webBaseUrl}/commits/${normalized}`;
  }
}

export function buildRemoteCreatePrUrl(remote: ParsedRemoteHost, sourceBranch: string): string | null {
  if (!isSafeBranchName(sourceBranch) || !validPathSegments(sourceBranch.split('/'))) {
    return null;
  }
  switch (remote.provider) {
    case 'github':
      return `${remote.webBaseUrl}/compare/${encodeBranchPath(sourceBranch)}?expand=1`;
    case 'azureDevOps':
      return `${remote.webBaseUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(sourceBranch)}`;
    case 'gitlab':
      return `${remote.webBaseUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(sourceBranch)}`;
    case 'bitbucket':
      return `${remote.webBaseUrl}/pull-requests/new?source=${encodeURIComponent(sourceBranch)}`;
  }
}

export function parseUpstreamRef(
  upstream: string,
  knownRemotes: readonly string[],
): { remoteName: string; remoteBranch: string } | null {
  const remotes = [...knownRemotes].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const remoteName of remotes) {
    const prefix = `${remoteName}/`;
    if (upstream.startsWith(prefix) && upstream.length > prefix.length) {
      return { remoteName, remoteBranch: upstream.slice(prefix.length) };
    }
  }
  const slash = upstream.indexOf('/');
  return slash > 0 && slash < upstream.length - 1
    ? { remoteName: upstream.slice(0, slash), remoteBranch: upstream.slice(slash + 1) }
    : null;
}

export function isUpstreamMismatchError(stderrOrMessage: string): boolean {
  return /does not match the name of your current branch|upstream branch of your current branch/i.test(stderrOrMessage);
}

export function isDefaultBranchName(branchName: string): boolean {
  return ['main', 'master', 'develop', 'trunk'].includes(branchName.toLowerCase());
}
