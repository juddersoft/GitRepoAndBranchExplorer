import { spawn } from 'child_process';
import * as fs from 'fs';

export type GitErrorCode = 'NOT_A_REPO' | 'GIT_NOT_FOUND' | 'TIMEOUT' | 'COMMAND_FAILED' | 'CANCELLED';

export class GitExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: GitErrorCode,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly outputLimitExceeded = false,
  ) {
    super(message);
    this.name = 'GitExecutionError';
  }
}

export interface ExecGitOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

export const DEFAULT_GIT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024;

const UNSAFE_REF_SEQUENCES: readonly string[] = ['..', '@{', '~', '^', ':', '?', '*', '[', '\\'];

/**
 * Validates a user/webview-supplied ref name before it is passed to Git.
 * Rejects option injection (`-x`), control characters, whitespace and revision-syntax characters.
 */
export function validateGitRef(ref: string): string {
  if (typeof ref !== 'string') {
    throw new Error('Git ref must be a string.');
  }
  if (/[\x00-\x1f\x7f]/.test(ref)) {
    throw new Error('Git ref must not contain control characters.');
  }
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new Error('Git ref must not be empty.');
  }
  if (trimmed.startsWith('-')) {
    throw new Error('Git ref must not start with "-".');
  }
  if (/\s/.test(trimmed)) {
    throw new Error('Git ref must not contain whitespace.');
  }
  const unsafe = UNSAFE_REF_SEQUENCES.find((seq) => trimmed.includes(seq));
  if (unsafe !== undefined) {
    throw new Error(`Git ref must not contain "${unsafe}".`);
  }
  if (
    trimmed === '@' ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock') ||
    trimmed.includes('//') ||
    trimmed.includes('/.')
  ) {
    throw new Error('Git ref is not a valid ref name.');
  }
  return trimmed;
}

function decode(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function classifyExitFailure(args: readonly string[], exitCode: number | null, stderr: string): GitExecutionError {
  const code: GitErrorCode = /not a git repository/i.test(stderr) ? 'NOT_A_REPO' : 'COMMAND_FAILED';
  const message = firstLine(stderr) || `git ${args[0] ?? ''} failed with exit code ${String(exitCode)}.`;
  return new GitExecutionError(message, code, exitCode, stderr);
}

function classifySpawnError(err: NodeJS.ErrnoException, cwd: string): GitExecutionError {
  if (err.code === 'ENOENT') {
    // spawn also reports ENOENT when cwd is missing, so distinguish that from a missing git binary.
    if (!fs.existsSync(cwd)) {
      return new GitExecutionError(`Working directory does not exist: ${cwd}`, 'COMMAND_FAILED', null, '');
    }
    return new GitExecutionError('Git executable was not found on PATH.', 'GIT_NOT_FOUND', null, '');
  }
  return new GitExecutionError(err.message, 'COMMAND_FAILED', null, '');
}

/** Runs git with an argument vector (no shell) and resolves with UTF-8 stdout. */
export function execGit(args: readonly string[], cwd: string, options: ExecGitOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  if (options.signal?.aborted) {
    return Promise.reject(new GitExecutionError('Git command cancelled.', 'CANCELLED', null, ''));
  }

  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      settle(() => {
        child.kill();
        reject(new GitExecutionError('Git command cancelled.', 'CANCELLED', null, decode(stderr)));
      });
    };

    const child = spawn('git', ['-c', 'color.ui=false', '-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Stable English stderr for error classification; never block on credential prompts.
        LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });

    timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(
          new GitExecutionError(
            `git ${args[0] ?? ''} timed out after ${timeoutMs}ms.`,
            'TIMEOUT',
            null,
            decode(stderr),
          ),
        );
      });
    }, timeoutMs);

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      action();
    }

    function rejectForOutputLimit(stream: 'stdout' | 'stderr', limit: number): void {
      settle(() => {
        child.kill();
        reject(
          new GitExecutionError(
            `git ${args[0] ?? ''} ${stream} output limit exceeded (${limit} bytes).`,
            'COMMAND_FAILED',
            null,
            decode(stderr),
            true,
          ),
        );
      });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        rejectForOutputLimit('stdout', maxStdoutBytes);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stderr.push(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        rejectForOutputLimit('stderr', maxStderrBytes);
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => settle(() => reject(classifySpawnError(err, cwd))));
    child.on('close', (exitCode: number | null) =>
      settle(() => {
        if (exitCode === 0) {
          resolve(decode(stdout));
        } else {
          reject(classifyExitFailure(args, exitCode, decode(stderr)));
        }
      }),
    );

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}
