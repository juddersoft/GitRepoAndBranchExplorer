import { BlameCache } from './blameCache';
import type { FileBlameMap } from './blameParser';
import { parseBlamePorcelain } from './blameParser';
import { execGit, GitExecutionError } from './gitExecutor';
import type { GitRunner } from './gitService';

export const BLAME_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const BLAME_TIMEOUT_MS = 15_000;

export interface BlameFileOptions {
  ignoreWhitespace?: boolean;
}

export function validateRelativeBlamePath(relativePath: string): string {
  if (typeof relativePath !== 'string') {
    throw new Error('Blame path must be a string.');
  }

  let normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (
    normalized.length === 0 ||
    normalized.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(normalized) ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Blame path must be a safe repository-relative path.');
  }
  return normalized;
}

function isGracefulBlameFailure(err: unknown): err is GitExecutionError {
  if (!(err instanceof GitExecutionError)) {
    return false;
  }
  if (err.code === 'NOT_A_REPO' || err.code === 'TIMEOUT' || err.outputLimitExceeded) {
    return true;
  }
  return (
    err.code === 'COMMAND_FAILED' &&
    /no such path|exists on disk, but not in|pathspec.*did not match|untracked|not tracked|ignored file|is ignored|does not exist/i.test(
      err.stderr,
    )
  );
}

export class GitBlameService {
  constructor(
    private readonly runGit: GitRunner = execGit,
    private readonly cache: BlameCache = new BlameCache(),
  ) {}

  public async getFileBlame(
    repoRoot: string,
    relativePath: string,
    options: BlameFileOptions = {},
  ): Promise<FileBlameMap | null> {
    if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
      throw new Error('Repository root must be a non-empty path.');
    }
    const normalizedPath = validateRelativeBlamePath(relativePath);
    const ignoreWhitespace = options.ignoreWhitespace === true;

    return this.cache.getOrLoad(
      { repoRoot, relativePath: normalizedPath, ignoreWhitespace },
      async () => {
        const args = [
          'blame',
          '--line-porcelain',
          ...(ignoreWhitespace ? ['-w'] : []),
          '--',
          normalizedPath,
        ];
        try {
          const output = await this.runGit(args, repoRoot, {
            timeoutMs: BLAME_TIMEOUT_MS,
            maxStdoutBytes: BLAME_MAX_STDOUT_BYTES,
          });
          return parseBlamePorcelain(output);
        } catch (err) {
          if (isGracefulBlameFailure(err)) {
            return null;
          }
          throw err;
        }
      },
    );
  }

  public getCachedFileBlame(
    repoRoot: string,
    relativePath: string,
    options: BlameFileOptions = {},
  ): FileBlameMap | undefined {
    return this.cache.get({
      repoRoot,
      relativePath: validateRelativeBlamePath(relativePath),
      ignoreWhitespace: options.ignoreWhitespace === true,
    });
  }

  public invalidateFile(repoRoot: string, relativePath: string): void {
    this.cache.invalidateFile(repoRoot, validateRelativeBlamePath(relativePath));
  }

  public invalidateRepo(repoRoot: string): void {
    if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
      throw new Error('Repository root must be a non-empty path.');
    }
    this.cache.invalidateRepo(repoRoot);
  }

  public clearCache(): void {
    this.cache.clear();
  }
}
