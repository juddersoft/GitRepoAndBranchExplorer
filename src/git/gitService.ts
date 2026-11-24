import * as path from 'path';
import type { BranchInfo, ChangedFileEntry, CommitDetails, CommitNode, RefBadge, RemoteGroup, RepoSnapshot, TagInfo } from '../types/git';
import { isChangedFileStatus, isSafeRepoRelativePath } from '../types/messages';
import type { ExecGitOptions } from './gitExecutor';
import { execGit, GitExecutionError, validateGitRef } from './gitExecutor';
import type { TrackedFetchResult } from './trackedFetch';
import { planTrackedFetch } from './trackedFetch';

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/';
const TAG_PREFIX = 'refs/tags/';

export const MAX_LOG_COMMITS = 500;

/**
 * `%(*objectname)` (7th field) peels annotated tags to their commit so tag badges land on the right commit.
 * The parser also accepts the 6-field form without it.
 */
export const FOR_EACH_REF_FORMAT =
  '%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(*objectname)%1e';

export const LOG_FORMAT = '%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%at%x1e';

export interface ParsedRefs {
  localBranches: BranchInfo[];
  remoteGroups: RemoteGroup[];
  tags: TagInfo[];
}

export type GitRunner = (args: readonly string[], cwd: string, options?: ExecGitOptions) => Promise<string>;

/** Network operations (fetch/pull/push) may legitimately take much longer than local reads. */
export const NETWORK_GIT_TIMEOUT_MS = 120_000;

/** Merge, rebase, cherry-pick, revert and tracking checkouts can rewrite many files in a large worktree. */
export const WORKTREE_GIT_TIMEOUT_MS = 120_000;

const STRICT_COMMIT_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Full-length SHA-1 (40 hex) or SHA-256 (64 hex) commit hash check applied before any hash reaches Git. */
export function isValidCommitHash(value: unknown): value is string {
  return typeof value === 'string' && STRICT_COMMIT_HASH.test(value);
}

/** Validates a commit hash and returns it lowercased for use in Git arguments. */
function assertCommitHash(hash: string): string {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash.');
  }
  return hash.toLowerCase();
}

/**
 * Validates a `<hash>[^]:<relativePath>` revision spec for `git show`, rejecting option injection,
 * absolute paths and `..` traversal. Returns the spec with its hash lowercased when valid.
 */
export function validateRevSpec(revSpec: string): string {
  if (typeof revSpec !== 'string' || revSpec.startsWith('-')) {
    throw new Error('Invalid revision spec.');
  }
  const colon = revSpec.indexOf(':');
  if (colon < 0) {
    throw new Error('Revision spec must have the form <hash>:<path>.');
  }
  const rev = revSpec.slice(0, colon);
  const filePath = revSpec.slice(colon + 1);
  const isParent = rev.endsWith('^');
  const hash = isParent ? rev.slice(0, -1) : rev;
  if (!isValidCommitHash(hash)) {
    throw new Error('Revision spec must start with a full 40- or 64-character commit hash.');
  }
  if (!isSafeRepoRelativePath(filePath)) {
    throw new Error('Revision spec path must be a safe repository-relative path.');
  }
  return `${hash.toLowerCase()}${isParent ? '^' : ''}:${filePath}`;
}

/**
 * Parses NUL-delimited `git diff-tree --name-status -r -z` output:
 * `<status>\0<path>\0` per entry, or `<R|C><score>\0<old>\0<new>\0` for renames and copies.
 */
export function parseDiffTreeOutput(rawOutput: string): ChangedFileEntry[] {
  const tokens = rawOutput.split('\0');
  const files: ChangedFileEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = (tokens[i] ?? '').trim();
    i++;
    if (statusToken.length === 0) {
      continue;
    }
    const status = statusToken[0];
    if (!isChangedFileStatus(status)) {
      // Unknown status letter (e.g. `X`): skip its single path token.
      i++;
      continue;
    }
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i];
      const newPath = tokens[i + 1];
      i += 2;
      if (oldPath && newPath) {
        files.push({ status, path: newPath, oldPath });
      }
    } else {
      const filePath = tokens[i];
      i++;
      if (filePath) {
        files.push({ status, path: filePath });
      }
    }
  }
  return files;
}

const GITHUB_REMOTE_PATTERNS: readonly RegExp[] = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^(?:https?|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
];
const GITHUB_NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Converts SSH/HTTPS GitHub remote URLs to `https://github.com/<owner>/<repo>`; null for anything else. */
export function normalizeGitHubRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) {
      continue;
    }
    const owner = match[1] ?? '';
    const repo = match[2] ?? '';
    if (!GITHUB_NAME_SEGMENT.test(owner) || !GITHUB_NAME_SEGMENT.test(repo) || repo === '.' || repo === '..') {
      return null;
    }
    return `https://github.com/${owner}/${repo}`;
  }
  return null;
}

const GITHUB_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Builds `<repoUrl>/commit/<hash>`, or null unless the URL is a normalized `https://github.com/` repo URL. */
export function buildGitHubCommitUrl(githubRemoteUrl: string, hash: string): string | null {
  if (!githubRemoteUrl.startsWith('https://github.com/') || !GITHUB_REPO_URL.test(githubRemoteUrl) || !isValidCommitHash(hash)) {
    return null;
  }
  return `${githubRemoteUrl}/commit/${hash.toLowerCase()}`;
}

/** Picks the first GitHub remote from `git remote -v` output, preferring `origin`. */
export function findGitHubRemoteInVerbose(rawOutput: string): string | null {
  const candidates = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([name, url]) => ({ name: name ?? '', url: normalizeGitHubRemoteUrl(url ?? '') }))
    .filter((c): c is { name: string; url: string } => c.url !== null);
  return (candidates.find((c) => c.name === 'origin') ?? candidates[0])?.url ?? null;
}

function splitRecords(rawOutput: string): string[] {
  return rawOutput
    .split(RECORD_SEP)
    .map((record) => record.replace(/^[\r\n]+/, ''))
    .filter((record) => record.length > 0);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parses `%(upstream:track)`; `[gone]` (upstream deleted) has no counts, so it is reported separately. */
export function parseUpstreamTrack(track: string): { ahead: number; behind: number; upstreamGone: boolean } {
  if (/\bgone\b/.test(track)) {
    return { ahead: 0, behind: 0, upstreamGone: true };
  }
  const ahead = /\bahead (\d+)/.exec(track);
  const behind = /\bbehind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number.parseInt(ahead[1], 10) : 0,
    behind: behind ? Number.parseInt(behind[1], 10) : 0,
    upstreamGone: false,
  };
}

export function parseForEachRefOutput(rawOutput: string): ParsedRefs {
  const localBranches: BranchInfo[] = [];
  const remotesByName = new Map<string, BranchInfo[]>();
  const tags: TagInfo[] = [];

  for (const record of splitRecords(rawOutput)) {
    const fields = record.split(FIELD_SEP);
    if (fields.length < 6) {
      continue;
    }
    // Names are derived from the full refname: %(refname:short) may be disambiguated (e.g. "heads/x").
    const [head, refname, , objectname, upstream, track, peeledHash = ''] = fields;

    if (refname.startsWith(LOCAL_PREFIX)) {
      const name = refname.slice(LOCAL_PREFIX.length);
      localBranches.push({
        name,
        displayName: name,
        fullName: refname,
        isCurrent: head === '*',
        isRemote: false,
        remoteName: null,
        tipHash: objectname,
        upstream: upstream || null,
        ...parseUpstreamTrack(track),
      });
    } else if (refname.startsWith(REMOTE_PREFIX)) {
      const name = refname.slice(REMOTE_PREFIX.length);
      const slash = name.indexOf('/');
      if (slash <= 0) {
        continue;
      }
      const remoteName = name.slice(0, slash);
      const displayName = name.slice(slash + 1);
      if (displayName === 'HEAD') {
        continue;
      }
      const branches = remotesByName.get(remoteName) ?? [];
      branches.push({
        name,
        displayName,
        fullName: refname,
        isCurrent: false,
        isRemote: true,
        remoteName,
        tipHash: objectname,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstreamGone: false,
      });
      remotesByName.set(remoteName, branches);
    } else if (refname.startsWith(TAG_PREFIX)) {
      tags.push({
        name: refname.slice(TAG_PREFIX.length),
        fullName: refname,
        targetHash: peeledHash || objectname,
      });
    }
  }

  const remoteGroups = [...remotesByName.entries()]
    .map(([remoteName, branches]) => ({ remoteName, branches }))
    .sort((a, b) => compareStrings(a.remoteName, b.remoteName));

  return { localBranches, remoteGroups, tags };
}

/** Maps commit hash -> badges in display order: HEAD, local branches, remote branches, tags. */
export function buildRefMap(refs: ParsedRefs, headHash: string | null): Map<string, RefBadge[]> {
  const map = new Map<string, RefBadge[]>();
  const add = (hash: string, badge: RefBadge): void => {
    const badges = map.get(hash) ?? [];
    badges.push(badge);
    map.set(hash, badges);
  };

  if (headHash) {
    add(headHash, { kind: 'head', label: 'HEAD' });
  }
  for (const branch of refs.localBranches) {
    add(branch.tipHash, { kind: 'localBranch', label: branch.name });
  }
  for (const group of refs.remoteGroups) {
    for (const branch of group.branches) {
      add(branch.tipHash, { kind: 'remoteBranch', label: branch.name });
    }
  }
  for (const tag of refs.tags) {
    add(tag.targetHash, { kind: 'tag', label: tag.name });
  }
  return map;
}

export function parseGitLogOutput(rawOutput: string, refMap: Map<string, RefBadge[]>): CommitNode[] {
  const commits: CommitNode[] = [];

  for (const record of splitRecords(rawOutput)) {
    const fields = record.split(FIELD_SEP);
    if (fields.length < 8) {
      continue;
    }
    const [hash, , parentsField] = fields;
    if (!HASH_PATTERN.test(hash)) {
      continue;
    }
    // The subject is the only free-form field; re-join it in case it contained the separator.
    const subject = fields.slice(3, fields.length - 4).join(FIELD_SEP);
    const [authorName, authorEmail, authorDateIso, timestampField] = fields.slice(-4);
    const authorTimestamp = Number.parseInt(timestampField, 10);

    commits.push({
      hash,
      shortHash: hash.slice(0, 8),
      parents: parentsField.split(' ').filter((parent) => parent.length > 0),
      subject,
      authorName,
      authorEmail,
      authorDateIso,
      authorTimestamp: Number.isFinite(authorTimestamp) ? authorTimestamp : 0,
      refs: [...(refMap.get(hash) ?? [])],
    });
  }
  return commits;
}

function isExpectedFailure(err: unknown): boolean {
  return err instanceof GitExecutionError && err.code === 'COMMAND_FAILED' && err.exitCode === 1;
}

export class GitService {
  constructor(private readonly runGit: GitRunner = execGit) {}

  public async getRepoSnapshot(workspaceFolderPath: string): Promise<RepoSnapshot> {
    const topLevel = await this.runGit(['rev-parse', '--show-toplevel'], workspaceFolderPath);
    const repoRoot = path.normalize(topLevel.trim());

    const [refOutput, head] = await Promise.all([
      this.runGit(['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], repoRoot),
      this.resolveHead(repoRoot),
    ]);
    const refs = parseForEachRefOutput(refOutput);
    const page = await this.readLog(repoRoot, MAX_LOG_COMMITS, 0, buildRefMap(refs, head.hash));

    const isDetachedHead = head.branch === null;
    const currentBranch = head.branch ?? (head.hash ? `HEAD (${head.hash.slice(0, 8)})` : 'HEAD');

    return {
      repoName: path.basename(repoRoot),
      repoRoot,
      currentBranch,
      isDetachedHead,
      ...refs,
      ...page,
    };
  }

  public async getCommitPage(
    repoRoot: string,
    skip: number,
    limit = MAX_LOG_COMMITS,
  ): Promise<{ commits: CommitNode[]; hasMoreCommits: boolean }> {
    const [refOutput, head] = await Promise.all([
      this.runGit(['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], repoRoot),
      this.resolveHead(repoRoot),
    ]);
    const refs = parseForEachRefOutput(refOutput);
    return this.readLog(repoRoot, limit, skip, buildRefMap(refs, head.hash));
  }

  public async getCommitDetails(repoRoot: string, commitHash: string): Promise<CommitDetails> {
    const hash = assertCommitHash(commitHash);
    const [body, diffTree] = await Promise.all([
      this.runGit(['show', '-s', '--format=%B', hash], repoRoot),
      // --diff-merges=first-parent lists merge-commit changes against the first parent (matching the `<hash>^` diff);
      // -M reports renames as `R` entries with their original path.
      this.runGit(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', '-M', '--diff-merges=first-parent', '-z', hash], repoRoot),
    ]);
    return { hash, body: body.replace(/\s+$/, ''), files: parseDiffTreeOutput(diffTree) };
  }

  /** Returns file contents at `<hash>:<path>` (or `<hash>^:<path>`), or `""` if the path/parent does not exist. */
  public async getFileContentAtRevision(repoRoot: string, revSpec: string): Promise<string> {
    const spec = validateRevSpec(revSpec);
    try {
      return await this.runGit(['show', spec], repoRoot, { maxStdoutBytes: 4 * 1024 * 1024 });
    } catch (err) {
      if (
        err instanceof GitExecutionError &&
        err.code === 'COMMAND_FAILED' &&
        /does not exist in|exists on disk, but not in|invalid object name|unknown revision|bad revision/i.test(err.stderr)
      ) {
        return '';
      }
      throw err;
    }
  }

  public async fetchAll(repoRoot: string): Promise<void> {
    await this.runGit(['fetch', '--all', '--prune'], repoRoot, { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
  }

  /**
   * Fetches (with prune) only the remotes that at least one local branch tracks. Branches without an upstream
   * are skipped rather than failing the operation. A failing remote does not stop the others; the failures
   * are reported together once every eligible remote has been tried.
   */
  public async fetchTrackedBranches(
    repoRoot: string,
    localBranches: readonly BranchInfo[],
    remoteGroups: readonly RemoteGroup[],
  ): Promise<TrackedFetchResult> {
    const plan = planTrackedFetch(localBranches, remoteGroups);
    const fetchedRemotes: string[] = [];
    const failures: string[] = [];
    for (const remote of plan.remotes) {
      try {
        const safeRemote = validateGitRef(remote);
        await this.runGit(['fetch', '--prune', '--', safeRemote], repoRoot, { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
        fetchedRemotes.push(safeRemote);
      } catch (err) {
        failures.push(`${remote}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
    return { ...plan, fetchedRemotes };
  }

  public async pullCurrentBranch(repoRoot: string): Promise<void> {
    await this.runGit(['pull'], repoRoot, { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
  }

  public async pushCurrentBranch(repoRoot: string, branchName: string, hasUpstream: boolean): Promise<void> {
    const ref = validateGitRef(branchName);
    const args = hasUpstream ? ['push'] : ['push', '-u', 'origin', ref];
    await this.runGit(args, repoRoot, { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
  }

  public async checkoutBranch(repoRoot: string, branchName: string): Promise<void> {
    const ref = validateGitRef(branchName);
    // Trailing `--` forces Git to treat the name as a revision, never as a pathspec.
    await this.runGit(['checkout', ref, '--'], repoRoot);
  }

  public async createBranch(repoRoot: string, branchName: string, startPoint?: string): Promise<void> {
    const ref = validateGitRef(branchName);
    const args = ['checkout', '-b', ref];
    if (startPoint !== undefined) {
      args.push(isValidCommitHash(startPoint) ? startPoint.toLowerCase() : validateGitRef(startPoint));
    }
    args.push('--');
    await this.runGit(args, repoRoot);
  }

  /** `--no-edit` keeps Git from opening an editor for the merge message (there is no terminal to host it). */
  public async mergeBranch(repoRoot: string, refName: string): Promise<void> {
    const ref = validateGitRef(refName);
    await this.runGit(['merge', '--no-edit', ref], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async rebaseOnto(repoRoot: string, refName: string): Promise<void> {
    const ref = validateGitRef(refName);
    await this.runGit(['rebase', ref], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async cherryPickCommit(repoRoot: string, hash: string): Promise<void> {
    await this.runGit(['cherry-pick', assertCommitHash(hash)], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async revertCommit(repoRoot: string, hash: string): Promise<void> {
    await this.runGit(['revert', '--no-edit', assertCommitHash(hash)], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async revertMergeCommit(repoRoot: string, hash: string, mainline = 1): Promise<void> {
    const normalizedHash = assertCommitHash(hash);
    if (!Number.isInteger(mainline) || mainline < 1) {
      throw new Error('Merge mainline parent must be a positive integer.');
    }
    await this.runGit(
      ['revert', '--no-edit', '-m', String(mainline), normalizedHash],
      repoRoot,
      { timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    );
  }

  public async resetCurrentBranch(repoRoot: string, target: string, mode: 'mixed' | 'hard'): Promise<void> {
    const validatedTarget = isValidCommitHash(target) ? target.toLowerCase() : validateGitRef(target);
    await this.runGit(
      ['reset', mode === 'hard' ? '--hard' : '--mixed', validatedTarget],
      repoRoot,
      { timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    );
  }

  /** `-d` refuses unmerged branches; `-D` (force) deletes regardless. */
  public async deleteLocalBranch(repoRoot: string, branchName: string, force = false): Promise<void> {
    const ref = validateGitRef(branchName);
    await this.runGit(['branch', force ? '-D' : '-d', ref], repoRoot);
  }

  /** Creates `localBranchName` tracking `remoteBranchName` (e.g. `origin/main`) and checks it out. */
  public async checkoutRemoteBranch(repoRoot: string, remoteBranchName: string, localBranchName: string): Promise<void> {
    const remote = validateGitRef(remoteBranchName);
    const local = validateGitRef(localBranchName);
    await this.runGit(['checkout', '-b', local, '--track', remote], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async getGitHubRemoteUrl(repoRoot: string): Promise<string | null> {
    try {
      const originUrl = normalizeGitHubRemoteUrl(await this.runGit(['remote', 'get-url', 'origin'], repoRoot));
      if (originUrl !== null) {
        return originUrl;
      }
    } catch (err) {
      // `origin` missing (exit 2) is expected; anything else is a real failure.
      if (!(err instanceof GitExecutionError && err.code === 'COMMAND_FAILED')) {
        throw err;
      }
    }
    return findGitHubRemoteInVerbose(await this.runGit(['remote', '-v'], repoRoot));
  }

  /** `branch` is null when HEAD is detached; `hash` is null on an unborn branch. */
  private async resolveHead(repoRoot: string): Promise<{ branch: string | null; hash: string | null }> {
    const [symbolicRef, hash] = await Promise.all([
      this.runGit(['symbolic-ref', '--quiet', 'HEAD'], repoRoot).then(
        (out) => out.trim(),
        (err: unknown) => {
          if (isExpectedFailure(err)) {
            return null;
          }
          throw err;
        },
      ),
      this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot).then(
        (out) => out.trim() || null,
        (err: unknown) => {
          if (isExpectedFailure(err)) {
            return null;
          }
          throw err;
        },
      ),
    ]);

    const branch =
      symbolicRef === null ? null : symbolicRef.startsWith(LOCAL_PREFIX) ? symbolicRef.slice(LOCAL_PREFIX.length) : symbolicRef;
    return { branch, hash };
  }

  private async readLog(
    repoRoot: string,
    maxCount = MAX_LOG_COMMITS,
    skip = 0,
    refMap: Map<string, RefBadge[]> = new Map(),
  ): Promise<{ commits: CommitNode[]; hasMoreCommits: boolean }> {
    try {
      const args = [
        'log',
        // Stash and notes refs are bookkeeping commits, not history.
        '--exclude=refs/stash',
        '--exclude=refs/notes/*',
        '--all',
        '--date-order',
        `--max-count=${maxCount + 1}`,
        ...(skip > 0 ? [`--skip=${skip}`] : []),
        `--format=${LOG_FORMAT}`,
      ];
      const parsed = parseGitLogOutput(await this.runGit(args, repoRoot), refMap);
      return {
        commits: parsed.slice(0, maxCount),
        hasMoreCommits: parsed.length > maxCount,
      };
    } catch (err) {
      if (err instanceof GitExecutionError && /does not have any commits yet/i.test(err.stderr)) {
        return { commits: [], hasMoreCommits: false };
      }
      throw err;
    }
  }
}
