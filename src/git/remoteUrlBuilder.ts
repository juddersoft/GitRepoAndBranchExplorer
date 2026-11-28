export type RemoteProvider = 'github' | 'azureDevOps' | 'gitlab' | 'bitbucket';

export interface ParsedRemoteHost {
  readonly provider: RemoteProvider;
  readonly webBaseUrl: string;
  readonly displayName: string;
}

export interface RemoteFileRef {
  readonly kind: 'branch' | 'commit';
  readonly value: string;
}

export type RemoteDestinationKind = 'hosted' | 'localPath' | 'other';

export interface RemoteDestinationInfo {
  readonly kind: RemoteDestinationKind;
  readonly rawUrl: string;
  readonly displayLabel: string;
  readonly providerName?: string;
}

export interface CloneUrlValidationResult {
  readonly valid: boolean;
  readonly normalized?: string;
  readonly error?: string;
}

export interface ParsedGitHubEnterpriseEndpoint {
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly hostname: string;
}

const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const COMMIT_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const GITHUB_ENTERPRISE_CLOUD_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/;

export function isGitHubEnterpriseCloudHost(hostname: string): boolean {
  return GITHUB_ENTERPRISE_CLOUD_HOST_PATTERN.test(hostname.toLowerCase());
}

export function isGitHubHostname(hostname: string): boolean {
  return hostname === 'github.com' || isGitHubEnterpriseCloudHost(hostname);
}

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
    (remote.username.length > 0 && remote.host !== 'dev.azure.com' && remote.host !== 'ssh.dev.azure.com' && !isGitHubHostname(remote.host) &&
      remote.host !== 'gitlab.com' && remote.host !== 'bitbucket.org');
  if (hasUnsafeCredential || (remote.username.length > 0 && remote.username !== 'git' && remote.host !== 'dev.azure.com')) {
    return null;
  }

  if (isGitHubHostname(remote.host) && path.length === 2 && path.every(safeNameSegment)) {
    return parsed(
      'github',
      `https://${remote.host}/${path[0]}/${path[1]}`,
      isGitHubEnterpriseCloudHost(remote.host) ? 'GitHub Enterprise' : 'GitHub',
    );
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

export function validateCloneUrl(rawUrl: string): CloneUrlValidationResult {
  const normalized = rawUrl.trim();
  if (normalized.length === 0) {
    return { valid: false, error: 'Repository URL is required.' };
  }
  if (normalized.length > 2048) {
    return { valid: false, error: 'Repository URL must be 2,048 characters or fewer.' };
  }
  if (CONTROL_CHARS.test(rawUrl)) {
    return { valid: false, error: 'Repository URL must not contain control characters.' };
  }
  if (normalized.startsWith('-')) {
    return { valid: false, error: 'Repository URL must not start with "-".' };
  }
  if (/^(?:ext::|fd::|javascript:|data:)/i.test(normalized)) {
    return { valid: false, error: 'Repository URL uses an unsafe scheme.' };
  }
  if (/^(?:https?|ssh):\/\//i.test(normalized)) {
    if (/\s/.test(normalized)) {
      return { valid: false, error: 'Repository URL must not contain whitespace.' };
    }
    try {
      const url = new URL(normalized);
      if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || url.hostname.length === 0) {
        return { valid: false, error: 'Repository URL must be a valid HTTP or SSH URL.' };
      }
      return { valid: true, normalized };
    } catch {
      return { valid: false, error: 'Repository URL is not valid.' };
    }
  }
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^\s]+)$/.exec(normalized);
  if (scp) {
    if (scp[1].startsWith('-') || scp[2].startsWith('-') || scp[3].startsWith('-')) {
      return { valid: false, error: 'SSH repository host and path must not start with "-".' };
    }
    return { valid: true, normalized };
  }
  if (classifyRemoteDestination(normalized).kind === 'localPath') {
    return { valid: true, normalized };
  }
  return { valid: false, error: 'Enter an HTTPS, HTTP, SSH, SCP-style SSH URL, or local repository path.' };
}

export function extractCloneFolderName(rawUrl: string): string {
  const withoutQuery = rawUrl.trim().replace(/[?#].*$/, '').replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const segment = withoutQuery.split(/[\\/:]/).filter(Boolean).at(-1) ?? '';
  const sanitized = segment.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-');
  return sanitized.length === 0 || sanitized === '.' || sanitized === '..' || sanitized.startsWith('-')
    ? 'repository'
    : sanitized;
}

export function validateCloneFolderName(folderName: string): { valid: boolean; error?: string } {
  if (folderName.length === 0 || !folderName.trim()) {
    return { valid: false, error: 'Folder name is required.' };
  }
  if (folderName === '.' || folderName === '..') {
    return { valid: false, error: 'Folder name cannot be "." or "..".' };
  }
  if (folderName.startsWith('-')) {
    return { valid: false, error: 'Folder name must not start with "-".' };
  }
  if (/[/\\]/.test(folderName)) {
    return { valid: false, error: 'Folder name must not contain path separators.' };
  }
  if (/[\x00-\x1f\x7f]/.test(folderName)) {
    return { valid: false, error: 'Folder name must not contain control characters.' };
  }
  if (/[<>:"|?*]/.test(folderName)) {
    return { valid: false, error: 'Folder name contains characters that are not valid in Windows filenames.' };
  }
  return { valid: true };
}

function isValidRfc1123MultiLabelHostname(hostname: string): boolean {
  const labels = hostname.split('.');
  return (
    labels.length >= 2 &&
    hostname.length <= 253 &&
    !/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(hostname) &&
    labels.every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
  );
}

export function resolveGitHubEnterpriseApiBaseUrl(rawUri: string): ParsedGitHubEnterpriseEndpoint | null {
  let url: URL;
  try {
    url = new URL(rawUri.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.port.length > 0
  ) {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'github.com' ||
    hostname === 'ghe.com' ||
    !isValidRfc1123MultiLabelHostname(hostname)
  ) {
    return null;
  }
  const webBaseUrl = `https://${hostname}`;
  return {
    webBaseUrl,
    hostname,
    apiBaseUrl: isGitHubEnterpriseCloudHost(hostname)
      ? `https://api.${hostname}`
      : `${webBaseUrl}/api/v3`,
  };
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

export function buildRemoteFileUrl(
  remote: ParsedRemoteHost,
  ref: RemoteFileRef,
  relativePath: string,
  startLine?: number,
  endLine?: number,
): string | null {
  if (
    typeof remote.webBaseUrl !== 'string' ||
    CONTROL_CHARS.test(remote.webBaseUrl) ||
    typeof ref?.value !== 'string' ||
    (ref.kind !== 'branch' && ref.kind !== 'commit') ||
    typeof relativePath !== 'string'
  ) {
    return null;
  }
  let remoteUrl: URL;
  try {
    remoteUrl = new URL(remote.webBaseUrl);
  } catch {
    return null;
  }
  if (
    remoteUrl.protocol !== 'https:' ||
    remoteUrl.hostname.length === 0 ||
    remoteUrl.username.length > 0 ||
    remoteUrl.password.length > 0 ||
    remoteUrl.search.length > 0 ||
    remoteUrl.hash.length > 0
  ) {
    return null;
  }
  let encodedRef: string;
  let normalizedRef: string;
  if (ref.kind === 'commit') {
    if (!COMMIT_HASH.test(ref.value)) {
      return null;
    }
    normalizedRef = ref.value.toLowerCase();
    encodedRef = normalizedRef;
  } else {
    if (!isSafeBranchName(ref.value) || !validPathSegments(ref.value.split('/'))) {
      return null;
    }
    normalizedRef = ref.value;
    encodedRef = encodeBranchPath(normalizedRef);
  }

  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
  const pathSegments = normalizedPath.split('/');
  if (
    normalizedPath.length === 0 ||
    normalizedPath.length > 4096 ||
    CONTROL_CHARS.test(normalizedPath) ||
    !validPathSegments(pathSegments)
  ) {
    return null;
  }
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    return null;
  }
  if (
    endLine !== undefined &&
    (!Number.isInteger(endLine) || endLine < 1 || startLine === undefined || endLine < startLine)
  ) {
    return null;
  }
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
  const lineStart = startLine;
  const lineEnd = endLine ?? startLine;
  switch (remote.provider) {
    case 'github': {
      const fragment = lineStart === undefined
        ? ''
        : `#L${lineStart}${lineEnd !== undefined && lineEnd !== lineStart ? `-L${lineEnd}` : ''}`;
      return `${remote.webBaseUrl}/blob/${encodedRef}/${encodedPath}${fragment}`;
    }
    case 'gitlab': {
      const fragment = lineStart === undefined
        ? ''
        : `#L${lineStart}${lineEnd !== undefined && lineEnd !== lineStart ? `-${lineEnd}` : ''}`;
      return `${remote.webBaseUrl}/-/blob/${encodedRef}/${encodedPath}${fragment}`;
    }
    case 'bitbucket': {
      const fragment = lineStart === undefined
        ? ''
        : `#lines-${lineStart}${lineEnd !== undefined && lineEnd !== lineStart ? `:${lineEnd}` : ''}`;
      return `${remote.webBaseUrl}/src/${encodedRef}/${encodedPath}${fragment}`;
    }
    case 'azureDevOps': {
      const version = ref.kind === 'branch' ? `GB${encodeURIComponent(normalizedRef)}` : `GC${normalizedRef}`;
      const lineParams = lineStart === undefined
        ? ''
        : `&line=${lineStart}&lineEnd=${lineEnd ?? lineStart}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain`;
      return `${remote.webBaseUrl}?path=${encodeURIComponent(`/${normalizedPath}`)}&version=${version}${lineParams}`;
    }
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
