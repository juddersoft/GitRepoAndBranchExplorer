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

/** Builds a read-only URI whose path ends with the file name so VS Code picks the right language mode. */
export function buildShowUri(repoRoot: string, revSpec: string, filePath: string): vscode.Uri {
  validateRevSpec(revSpec);
  return vscode.Uri.from({
    scheme: GIT_SHOW_SCHEME,
    path: `/${filePath}`,
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
