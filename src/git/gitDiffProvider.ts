import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangedFileStatus } from '../types/git';
import { GitService, validateRevSpec } from './gitService';

export const GIT_SHOW_SCHEME = 'git-repo-explorer-show';

interface ShowUriQuery {
  repoRoot: string;
  revSpec: string;
}

function parseQuery(uri: vscode.Uri): ShowUriQuery {
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
  constructor(private readonly gitService: GitService = new GitService()) {}

  public provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { repoRoot, revSpec } = parseQuery(uri);
    return this.gitService.getFileContentAtRevision(repoRoot, revSpec);
  }
}

export function registerGitShowContentProvider(gitService?: GitService): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, new GitShowContentProvider(gitService));
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
