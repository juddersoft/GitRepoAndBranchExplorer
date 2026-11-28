import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangedFileStatus } from '../types/git';
import { GitService, validateRevSpec } from './gitService';

export const GIT_SHOW_SCHEME = 'git-repo-explorer-show';
export const WORKSPACE_TRUST_REQUIRED_MESSAGE =
  'Git Repo & Branch Explorer requires a trusted workspace before Git repository content can be read.';
export const REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE = 'Access denied: repository root is not authorized.';

interface ShowUriQuery {
  repoRoot: string;
  revSpec: string;
}

function parseQuery(uri: vscode.Uri): ShowUriQuery {
  if (uri.scheme !== GIT_SHOW_SCHEME) {
    throw new Error('Malformed git-repo-explorer-show URI.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(uri.query);
  } catch {
    throw new Error('Malformed git-repo-explorer-show URI.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Malformed git-repo-explorer-show URI.');
  }
  const { repoRoot, revSpec } = parsed as Record<string, unknown>;
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || typeof revSpec !== 'string') {
    throw new Error('Malformed git-repo-explorer-show URI.');
  }
  return { repoRoot, revSpec: validateRevSpec(revSpec) };
}

export function normalizeRepoRootPath(inputPath: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(inputPath);
  const root = pathApi.parse(resolved).root;
  if (resolved === root) {
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  const trimmed = resolved.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function isAuthorizedRepoRoot(
  candidateRoot: string,
  allowedRoots: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedCandidate = normalizeRepoRootPath(candidateRoot, platform);
  for (const allowedRoot of allowedRoots) {
    if (normalizeRepoRootPath(allowedRoot, platform) === normalizedCandidate) {
      return true;
    }
  }
  return false;
}

export function buildVersionedDisplayPath(filePath: string, versionTag: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const slash = normalizedPath.lastIndexOf('/');
  const directory = slash < 0 ? '' : normalizedPath.slice(0, slash + 1);
  const name = normalizedPath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  return `${directory}${stem} [${versionTag}]${extension}`;
}

export function formatRevisionTag(
  role: 'OLDER' | 'NEWER' | 'PREVIOUS' | 'COMMIT',
  shortHash: string,
  isoDate?: string,
): string {
  const date = revisionDatePart(isoDate);
  return `${role} ${shortHash}${date === undefined ? '' : ` \u2022 ${date}`}`;
}

function revisionDatePart(isoDate: string | undefined): string | undefined {
  if (isoDate === undefined || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) {
    return undefined;
  }
  const datePart = isoDate.slice(0, 10);
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== datePart
    ? undefined
    : datePart;
}

/** Builds a read-only URI whose display path preserves the extension and labels its version. */
export function buildShowUri(
  repoRoot: string,
  revSpec: string,
  filePath: string,
  displayTag?: string,
): vscode.Uri {
  validateRevSpec(revSpec);
  return vscode.Uri.from({
    scheme: GIT_SHOW_SCHEME,
    path: `/${displayTag === undefined ? filePath : buildVersionedDisplayPath(filePath, displayTag)}`,
    query: JSON.stringify({ repoRoot, revSpec } satisfies ShowUriQuery),
  });
}

/** Serves file contents at a given revision for the read-only diff editor. */
export class GitShowContentProvider implements vscode.TextDocumentContentProvider {
  private allowedRepoRoots = new Set<string>();

  constructor(private readonly gitService: GitService = new GitService()) {}

  public setAllowedRepoRoots(roots: Iterable<string>): void {
    this.allowedRepoRoots = new Set(Array.from(roots, (root) => normalizeRepoRootPath(root)));
  }

  public clearAllowedRepoRoots(): void {
    this.allowedRepoRoots.clear();
  }

  public provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (!vscode.workspace.isTrusted) {
      throw new Error(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    }
    const { repoRoot, revSpec } = parseQuery(uri);
    if (!isAuthorizedRepoRoot(repoRoot, this.allowedRepoRoots)) {
      throw new Error(REPOSITORY_ROOT_NOT_AUTHORIZED_MESSAGE);
    }
    return this.gitService.getFileContentAtRevision(repoRoot, revSpec);
  }

  public async openTwoRevisionFileDiff(
    repoRoot: string,
    older: { hash: string; shortHash: string; path: string; isoDate?: string },
    newer: { hash: string; shortHash: string; path: string; isoDate?: string },
  ): Promise<void> {
    this.ensureTrustedWorkspace();
    const leftUri = buildShowUri(
      repoRoot,
      `${older.hash}:${older.path}`,
      older.path,
      formatRevisionTag('OLDER', older.shortHash, older.isoDate),
    );
    const rightUri = buildShowUri(
      repoRoot,
      `${newer.hash}:${newer.path}`,
      newer.path,
      formatRevisionTag('NEWER', newer.shortHash, newer.isoDate),
    );
    const oldName = path.posix.basename(older.path);
    const newName = path.posix.basename(newer.path);
    const label = oldName === newName ? newName : `${oldName} \u2192 ${newName}`;
    const olderDatePart = revisionDatePart(older.isoDate);
    const newerDatePart = revisionDatePart(newer.isoDate);
    const olderDate = olderDatePart === undefined ? '' : ` \u2022 ${olderDatePart}`;
    const newerDate = newerDatePart === undefined ? '' : ` \u2022 ${newerDatePart}`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `${label} \u2014 OLDER (${older.shortHash}${olderDate}) \u2194 NEWER (${newer.shortHash}${newerDate})`,
      { preview: true },
    );
  }

  public async openRevisionVsWorkingTreeDiff(
    repoRoot: string,
    revision: { hash: string; shortHash: string; pathAtCommit: string; isoDate?: string },
    currentRelativePath: string,
  ): Promise<void> {
    this.ensureTrustedWorkspace();
    const absolutePath = path.resolve(repoRoot, currentRelativePath);
    const relative = path.relative(path.resolve(repoRoot), absolutePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Working-tree file must be inside the repository.');
    }
    const leftUri = buildShowUri(
      repoRoot,
      `${revision.hash}:${revision.pathAtCommit}`,
      revision.pathAtCommit,
      formatRevisionTag('OLDER', revision.shortHash, revision.isoDate),
    );
    const datePart = revisionDatePart(revision.isoDate);
    const date = datePart === undefined ? '' : ` \u2022 ${datePart}`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      vscode.Uri.file(absolutePath),
      `${path.posix.basename(currentRelativePath)} \u2014 OLDER (${revision.shortHash}${date}) \u2194 WORKING TREE`,
      { preview: true },
    );
  }

  public async openSingleRevisionFile(
    repoRoot: string,
    revision: { hash: string; shortHash: string; pathAtCommit: string; isoDate?: string },
  ): Promise<void> {
    this.ensureTrustedWorkspace();
    await vscode.window.showTextDocument(
      buildShowUri(
        repoRoot,
        `${revision.hash}:${revision.pathAtCommit}`,
        revision.pathAtCommit,
        formatRevisionTag('COMMIT', revision.shortHash, revision.isoDate),
      ),
      { preview: true },
    );
  }

  private ensureTrustedWorkspace(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error(WORKSPACE_TRUST_REQUIRED_MESSAGE);
    }
  }
}

export function registerGitShowContentProvider(
  provider: GitShowContentProvider = new GitShowContentProvider(),
): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, provider);
}

/** Opens VS Code's native diff editor comparing `<hash>^` against `<hash>` for one changed file. */
export async function openCommitFileDiff(
  repoRoot: string,
  hash: string,
  filePath: string,
  status: ChangedFileStatus,
  oldPath?: string,
): Promise<void> {
  const leftPath = oldPath ?? filePath;
  const leftUri = buildShowUri(repoRoot, `${hash}^:${leftPath}`, leftPath);
  const rightUri = buildShowUri(repoRoot, `${hash}:${filePath}`, filePath);
  const shortHash = hash.slice(0, 8);
  const name = path.posix.basename(filePath);
  const label =
    status === 'R' || status === 'C' ? `${path.posix.basename(leftPath)} \u2192 ${name}` : name;
  const title = `${label} (${shortHash}^ \u2194 ${shortHash})`;
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
}
