import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceRepoInfo } from '../types/git';
import { execGit, type ExecGitOptions } from './gitExecutor';

export type RepoGitRunner = (args: readonly string[], cwd: string, options?: ExecGitOptions) => Promise<string>;

export const DISCOVERY_SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'out-test',
  'coverage',
  '.vscode-test',
  '.vs',
  'bin',
  'obj',
  'target',
]);

export function canonicalizeRepoPath(
  inputPath: string,
  basePath = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(basePath, inputPath);
  const trimmed = resolved === pathApi.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.toLowerCase().replace(/\//g, '\\') : trimmed;
}

async function canonicalizeExistingPath(inputPath: string, basePath: string): Promise<string> {
  const resolved = path.resolve(basePath, inputPath);
  try {
    return canonicalizeRepoPath(await fs.promises.realpath(resolved));
  } catch {
    return canonicalizeRepoPath(resolved);
  }
}

function candidatePathKey(inputPath: string): string {
  const canonical = canonicalizeRepoPath(inputPath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function hasGitEntry(directory: string): Promise<boolean> {
  try {
    await fs.promises.lstat(path.join(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function collectRepositoryCandidates(
  workspaceFolderPaths: readonly string[],
  configuredWorkspaceRoot?: string,
): Promise<string[]> {
  const candidates = new Map<string, string>();
  for (const folderPath of workspaceFolderPaths) {
    const key = candidatePathKey(folderPath);
    candidates.set(key, path.resolve(folderPath));
  }

  const scanRoots = new Map<string, string>();
  if (configuredWorkspaceRoot?.trim()) {
    scanRoots.set(candidatePathKey(configuredWorkspaceRoot), path.resolve(configuredWorkspaceRoot));
  }
  for (const folderPath of workspaceFolderPaths) {
    if (!(await hasGitEntry(folderPath))) {
      scanRoots.set(candidatePathKey(folderPath), path.resolve(folderPath));
    }
  }

  for (const root of scanRoots.values()) {
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      if (next.depth > 2) {
        continue;
      }
      if (await hasGitEntry(next.directory)) {
        candidates.set(candidatePathKey(next.directory), path.resolve(next.directory));
        continue;
      }
      if (next.depth === 2) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(next.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || DISCOVERY_SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
          continue;
        }
        const directory = path.join(next.directory, entry.name);
        queue.push({ directory, depth: next.depth + 1 });
      }
    }
  }
  return Array.from(candidates.values());
}

function preferRepositoryRoot(current: WorkspaceRepoInfo, next: WorkspaceRepoInfo): WorkspaceRepoInfo {
  const isPrimary = (repo: WorkspaceRepoInfo): boolean =>
    canonicalizeRepoPath(path.dirname(repo.commonDir)) === canonicalizeRepoPath(repo.repoRoot);
  const currentPrimary = isPrimary(current);
  const nextPrimary = isPrimary(next);
  if (nextPrimary !== currentPrimary) {
    return nextPrimary ? next : current;
  }
  return next.repoRoot.localeCompare(current.repoRoot, undefined, { sensitivity: 'base' }) < 0 ? next : current;
}

export async function inspectRepository(
  candidateDir: string,
  gitRunner: RepoGitRunner = execGit,
): Promise<WorkspaceRepoInfo | null> {
  try {
    const locations = (await gitRunner(['rev-parse', '--show-toplevel', '--git-common-dir'], candidateDir))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const rawRepoRoot = locations[0];
    const rawCommonDir = locations[1];
    if (!rawRepoRoot || !rawCommonDir) {
      return null;
    }
    const repoRoot = await canonicalizeExistingPath(rawRepoRoot, candidateDir);
    const commonDir = await canonicalizeExistingPath(rawCommonDir, candidateDir);
    let currentBranch: string | undefined;
    let isDetachedHead: boolean | undefined;
    try {
      const symbolicRef = (await gitRunner(['symbolic-ref', '--quiet', 'HEAD'], repoRoot)).trim();
      if (symbolicRef) {
        currentBranch = symbolicRef.replace(/^refs\/heads\//, '');
        isDetachedHead = false;
      }
    } catch {
      // A detached HEAD is identified by the short commit fallback below.
    }
    if (currentBranch === undefined) {
      try {
        currentBranch = (await gitRunner(['rev-parse', '--short', 'HEAD'], repoRoot)).trim();
        if (currentBranch) {
          isDetachedHead = true;
        }
      } catch {
        // Unborn repositories may have no resolvable HEAD commit.
      }
    }
    return {
      repoRoot,
      repoName: path.basename(repoRoot),
      commonDir,
      ...(currentBranch ? { currentBranch } : {}),
      ...(isDetachedHead === undefined ? {} : { isDetachedHead }),
    };
  } catch {
    return null;
  }
}

export async function discoverWorkspaceRepositories(
  workspaceFolderPaths: string[],
  configuredWorkspaceRoot?: string,
  gitRunner: RepoGitRunner = execGit,
): Promise<WorkspaceRepoInfo[]> {
  const candidates = await collectRepositoryCandidates(workspaceFolderPaths, configuredWorkspaceRoot);
  const byCommonDir = new Map<string, WorkspaceRepoInfo>();
  for (const candidate of candidates) {
    const repository = await inspectRepository(candidate, gitRunner);
    if (!repository) {
      continue;
    }
    const key = canonicalizeRepoPath(repository.commonDir);
    const existing = byCommonDir.get(key);
    byCommonDir.set(key, existing ? preferRepositoryRoot(existing, repository) : repository);
  }
  return [...byCommonDir.values()].sort((left, right) =>
    left.repoName.localeCompare(right.repoName, undefined, { sensitivity: 'base' }) ||
    left.repoRoot.localeCompare(right.repoRoot, undefined, { sensitivity: 'base' }),
  );
}
