import * as fs from 'fs';
import * as path from 'path';
import type { BranchInfo, ChangedFileEntry, CommitDetails, CommitNode, RefBadge, RemoteGroup, RepoSnapshot, StashInfo, TagInfo, WorkingTreeFile, WorktreeInfo } from '../types/git';
import { isChangedFileStatus, isSafeRepoRelativePath } from '../types/messages';
import type { ExecGitOptions } from './gitExecutor';
import { execGit, GitExecutionError, validateGitRef } from './gitExecutor';
import type { TrackedFetchResult } from './trackedFetch';
import { planTrackedFetch } from './trackedFetch';
import {
  buildRemoteCommitUrl,
  classifyRemoteDestination,
  parseRemoteHostInfo,
  validateCloneFolderName,
  validateCloneUrl,
} from './remoteUrlBuilder.js';

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const HASH_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/';
const TAG_PREFIX = 'refs/tags/';

export const MAX_LOG_COMMITS = 500;

/**
 * `%(*objectname)` (7th field) peels annotated tags to their commit so tag badges land on the right commit.
 * The parser also accepts older 6-field fixtures and peels the optional symref field at the end.
 */
export const FOR_EACH_REF_FORMAT =
  '%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(*objectname)%1f%(symref)%1e';

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

export interface CreateBranchOptions {
  readonly checkout?: boolean;
  readonly track?: boolean;
}

function normalizeWorktreePath(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function validateWorktreePath(worktreePath: string): string {
  if (
    worktreePath.length === 0 ||
    !worktreePath.trim() ||
    worktreePath.startsWith('-') ||
    /[\x00-\x1f\x7f]/.test(worktreePath)
  ) {
    throw new Error('Invalid worktree path.');
  }
  return worktreePath;
}

/** Parses `git worktree list --porcelain`, preserving paths containing spaces. */
export function parseWorktreeListPorcelain(output: string, activeRepoRoot: string): WorktreeInfo[] {
  const activePath = normalizeWorktreePath(activeRepoRoot);
  const stanzas = output.replace(/\r\n/g, '\n').trim().split(/\n{2,}/).filter(Boolean);
  return stanzas.map((stanza, index) => {
    let worktreePath = '';
    let headHash = '';
    let branchName: string | null = null;
    let isDetached = false;
    let isBare = false;
    let isLocked = false;
    let isPrunable = false;

    for (const line of stanza.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        headHash = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        branchName = ref.startsWith(LOCAL_PREFIX) ? ref.slice(LOCAL_PREFIX.length) : ref;
      } else if (line === 'detached') {
        isDetached = true;
      } else if (line === 'bare') {
        isBare = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        isLocked = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        isPrunable = true;
      }
    }

    return {
      path: worktreePath,
      headHash,
      branchName,
      isDetached,
      isBare,
      isMain: index === 0,
      isCurrent: normalizeWorktreePath(worktreePath) === activePath,
      isLocked,
      isPrunable,
    };
  }).filter((worktree) => worktree.path.length > 0);
}

const STRICT_COMMIT_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Full-length SHA-1 (40 hex) or SHA-256 (64 hex) commit hash check applied before any hash reaches Git. */
export function isValidCommitHash(value: unknown): value is string {
  return typeof value === 'string' && STRICT_COMMIT_HASH.test(value);
}

const STASH_REF_PATTERN = /^stash@\{([0-9]+)\}$/;
const STASH_HASH_PATTERN = /^[0-9a-f]{40}$/i;

export function parseStashListOutput(output: string): StashInfo[] {
  const stashes: StashInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    const [hash, ref, message = '', timestampText, ...extra] = line.split('\x1f');
    const refMatch = ref === undefined ? null : STASH_REF_PATTERN.exec(ref);
    const index = refMatch === null ? Number.NaN : Number(refMatch[1]);
    const timestamp = Number(timestampText);
    if (
      extra.length > 0 ||
      refMatch === null ||
      !Number.isSafeInteger(index) ||
      !STASH_HASH_PATTERN.test(hash ?? '') ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0
    ) {
      throw new Error('Git returned an invalid stash list entry.');
    }
    stashes.push({
      index,
      ref: ref!,
      hash: hash.toLowerCase(),
      message,
      timestamp,
    });
  }
  return stashes;
}

export function validateStashRef(value: string): string {
  if (!STASH_REF_PATTERN.test(value)) {
    throw new Error('Invalid stash reference; expected stash@{N}.');
  }
  return value;
}

export function parsePorcelainStatusZ(rawOutput: string): WorkingTreeFile[] {
  const tokens = rawOutput.split('\0');
  const files: WorkingTreeFile[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index] ?? '';
    if (record.length === 0) {
      continue;
    }
    if (record.length < 3) {
      throw new Error('Git returned an invalid porcelain status record.');
    }
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const path = record.slice(3);
    if (path.length === 0) {
      throw new Error('Git returned an invalid empty working-tree path.');
    }
    const renamedOrCopied = indexStatus === 'R' || indexStatus === 'C' ||
      worktreeStatus === 'R' || worktreeStatus === 'C';
    const originalPath = renamedOrCopied ? tokens[++index] : undefined;
    if (renamedOrCopied && (!originalPath || originalPath.length === 0)) {
      throw new Error('Git returned a rename without its original path.');
    }
    files.push({
      path,
      indexStatus,
      worktreeStatus,
      untracked: indexStatus === '?' && worktreeStatus === '?',
      ...(originalPath === undefined ? {} : { originalPath }),
    });
  }
  return files;
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

/** Converts supported GitHub remote URL formats to a normalized HTTPS repository URL. */
export function normalizeGitHubRemoteUrl(remoteUrl: string): string | null {
  const parsed = parseRemoteHostInfo(remoteUrl);
  return parsed?.provider === 'github' ? parsed.webBaseUrl : null;
}

/** Builds a commit URL for a normalized HTTPS GitHub or GitHub Enterprise Cloud repository URL. */
export function buildGitHubCommitUrl(githubRemoteUrl: string, hash: string): string | null {
  const trimmedRepoUrl = githubRemoteUrl.trim();
  if (!trimmedRepoUrl.startsWith('https://')) {
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedRepoUrl);
  } catch {
    return null;
  }
  if (parsedUrl.pathname.replace(/\/+$/, '').toLowerCase().endsWith('.git')) {
    return null;
  }
  const parsed = parseRemoteHostInfo(trimmedRepoUrl);
  return parsed?.provider === 'github' ? buildRemoteCommitUrl(parsed, hash) : null;
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
  const defaultBranchesByName = new Map<string, string>();
  const tags: TagInfo[] = [];

  for (const record of splitRecords(rawOutput)) {
    const fields = record.split(FIELD_SEP);
    if (fields.length < 6) {
      continue;
    }
    // Names are derived from the full refname: %(refname:short) may be disambiguated (e.g. "heads/x").
    const [head, refname, , objectname, upstream, track, peeledHash = '', symref = ''] = fields;

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
        if (!remotesByName.has(remoteName)) {
          remotesByName.set(remoteName, []);
        }
        const symrefPrefix = `refs/remotes/${remoteName}/`;
        if (symref.startsWith(symrefPrefix)) {
          const defaultBranch = symref.slice(symrefPrefix.length);
          if (defaultBranch.length > 0) {
            defaultBranchesByName.set(remoteName, defaultBranch);
          }
        }
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
    .map(([remoteName, branches]): RemoteGroup => {
      const symrefDefault = defaultBranchesByName.get(remoteName);
      const branchNames = new Set(branches.map((branch) => branch.displayName));
      const fallbackDefault =
        branchNames.has('main') && !branchNames.has('master')
          ? 'main'
          : branchNames.has('master') && !branchNames.has('main')
            ? 'master'
            : undefined;
      const defaultBranch = symrefDefault ?? fallbackDefault;
      return defaultBranch === undefined
        ? { remoteName, branches }
        : { remoteName, branches, defaultBranch };
    })
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

  public async cloneRepository(
    rawUrl: string,
    parentDir: string,
    folderName: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<string> {
    const validatedUrl = validateCloneUrl(rawUrl);
    if (!validatedUrl.valid || validatedUrl.normalized === undefined) {
      throw new Error(validatedUrl.error ?? 'Repository URL is invalid.');
    }
    const folderValidation = validateCloneFolderName(folderName);
    if (!folderValidation.valid) {
      throw new Error(folderValidation.error ?? 'Folder name is invalid.');
    }
    let parentStat: fs.Stats;
    try {
      parentStat = fs.statSync(parentDir);
    } catch (err) {
      throw new Error(`Clone destination folder does not exist: ${parentDir}`, { cause: err });
    }
    if (!parentStat.isDirectory()) {
      throw new Error(`Clone destination is not a folder: ${parentDir}`);
    }
    const targetPath = path.join(parentDir, folderName);
    if (fs.existsSync(targetPath)) {
      throw new Error(`Clone destination already exists: ${targetPath}`);
    }
    await this.runGit(
      ['clone', '--', validatedUrl.normalized, folderName],
      parentDir,
      { timeoutMs: options.timeoutMs ?? 300_000, signal: options.signal },
    );
    return targetPath;
  }

  public async getRepoSnapshot(workspaceFolderPath: string): Promise<RepoSnapshot> {
    const topLevel = await this.runGit(['rev-parse', '--show-toplevel'], workspaceFolderPath);
    const repoRoot = path.normalize(topLevel.trim());

    const [refOutput, head, remoteOutput, worktreesResult, stashes] = await Promise.all([
      this.runGit(['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], repoRoot),
      this.resolveHead(repoRoot),
      this.runGit(['remote', '-v'], repoRoot),
      this.listWorktrees(repoRoot).catch(() => null),
      this.listStashes(repoRoot),
    ]);
    const refs = parseForEachRefOutput(refOutput);
    const worktrees = worktreesResult === null
      ? [{
          path: repoRoot,
          headHash: head.hash ?? '',
          branchName: head.branch,
          isDetached: head.branch === null,
          isBare: false,
          isMain: true,
          isCurrent: true,
          isLocked: false,
          isPrunable: false,
        }]
      : worktreesResult;
    const worktreesByBranch = new Map(
      worktrees.flatMap((worktree) => worktree.branchName === null ? [] : [[worktree.branchName, worktree.path] as const]),
    );
    refs.localBranches.forEach((branch) => {
      branch.worktreePath = worktreesByBranch.get(branch.name) ?? null;
    });
    const remoteDestinations = this.parseRemoteDestinations(remoteOutput);
    const remoteNames = [...remoteDestinations.keys()].sort(compareStrings);
    const remoteGroupNames = [...new Set([
      ...remoteNames,
      ...refs.remoteGroups.map((group) => group.remoteName),
    ])].sort(compareStrings);
    const groupsByName = new Map(refs.remoteGroups.map((group) => [group.remoteName, group]));
    const remoteGroups = remoteGroupNames.map((remoteName): RemoteGroup => {
      const group = groupsByName.get(remoteName) ?? { remoteName, branches: [] };
      const url = remoteDestinations.get(remoteName);
      if (url === undefined) {
        return group;
      }
      const destination = classifyRemoteDestination(url);
      return {
        ...group,
        url,
        destinationKind: destination.kind,
        ...(destination.providerName === undefined ? {} : { providerName: destination.providerName }),
      };
    });
    const page = await this.readLog(repoRoot, MAX_LOG_COMMITS, 0, buildRefMap(refs, head.hash));

    const isDetachedHead = head.branch === null;
    const currentBranch = head.branch ?? (head.hash ? `HEAD (${head.hash.slice(0, 8)})` : 'HEAD');

    return {
      repoName: path.basename(repoRoot),
      repoRoot,
      currentBranch,
      isDetachedHead,
      remotes: remoteNames,
      localBranches: refs.localBranches,
      remoteGroups,
      worktrees,
      stashes,
      tags: refs.tags,
      ...page,
    };
  }

  public async listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
    const output = await this.runGit(['worktree', 'list', '--porcelain'], repoRoot);
    return parseWorktreeListPorcelain(output, repoRoot);
  }

  public async listStashes(repoRoot: string): Promise<StashInfo[]> {
    const output = await this.runGit(
      ['stash', 'list', '--format=%H%x1f%gd%x1f%gs%x1f%ct'],
      repoRoot,
    );
    return parseStashListOutput(output);
  }

  public async getWorkingTreeFiles(repoRoot: string): Promise<WorkingTreeFile[]> {
    return parsePorcelainStatusZ(
      await this.runGit(['status', '--porcelain=v1', '-z'], repoRoot),
    );
  }

  public async stashPush(
    repoRoot: string,
    options: { message?: string; includeUntracked?: boolean; paths?: string[] } = {},
  ): Promise<void> {
    let message: string | undefined;
    if (options.message !== undefined) {
      if (/[\x00-\x1f\x7f]/.test(options.message)) {
        throw new Error('Stash messages cannot contain control characters.');
      }
      message = options.message.trim() || undefined;
    }
    const validatedPaths = options.paths?.map((filePath) => {
      if (
        typeof filePath !== 'string' ||
        filePath.length === 0 ||
        filePath.startsWith('-') ||
        /[\x00-\x1f\x7f]/.test(filePath) ||
        /^[\\/]/.test(filePath) ||
        /^[a-zA-Z]:/.test(filePath) ||
        filePath.split(/[\\/]/).some((segment) => segment === '..')
      ) {
        throw new Error(`Invalid stash path: ${String(filePath)}`);
      }
      return filePath;
    }) ?? [];
    await this.runGit(
      [
        'stash',
        'push',
        ...(options.includeUntracked ? ['-u'] : []),
        ...(message === undefined ? [] : ['-m', message]),
        ...(validatedPaths.length > 0 ? ['--', ...validatedPaths] : []),
      ],
      repoRoot,
      { timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    );
  }

  public async applyStash(repoRoot: string, stashRef: string): Promise<void> {
    const ref = validateStashRef(stashRef);
    await this.runGit(['stash', 'apply', ref], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async popStash(repoRoot: string, stashRef: string): Promise<void> {
    const ref = validateStashRef(stashRef);
    await this.runGit(['stash', 'pop', ref], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async dropStash(repoRoot: string, stashRef: string): Promise<void> {
    const ref = validateStashRef(stashRef);
    await this.runGit(['stash', 'drop', ref], repoRoot);
  }

  public async addWorktree(
    repoRoot: string,
    targetPath: string,
    options: { branchName: string; createBranch?: boolean; startPoint?: string },
  ): Promise<void> {
    const branchName = validateGitRef(options.branchName);
    const startPoint = options.startPoint === undefined ? undefined : validateGitRef(options.startPoint);
    const validatedPath = validateWorktreePath(targetPath);
    const args = options.createBranch
      ? ['worktree', 'add', '-b', branchName, validatedPath, ...(startPoint === undefined ? [] : [startPoint])]
      : ['worktree', 'add', validatedPath, branchName];
    await this.runGit(args, repoRoot);
  }

  public async removeWorktree(repoRoot: string, worktreePath: string, force = false): Promise<void> {
    const validatedPath = validateWorktreePath(worktreePath);
    await this.runGit(
      ['worktree', 'remove', ...(force ? ['--force'] : []), validatedPath],
      repoRoot,
    );
  }

  private parseRemoteDestinations(rawOutput: string): Map<string, string> {
    const destinations = new Map<string, { fetch?: string; push?: string }>();
    for (const line of rawOutput.split(/\r?\n/)) {
      const match = /^\s*(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/.exec(line);
      if (!match) {
        continue;
      }
      const [, remoteName, url, operation] = match;
      const existing = destinations.get(remoteName) ?? {};
      if (operation === 'push') {
        existing.push = url;
      } else {
        existing.fetch = url;
      }
      destinations.set(remoteName, existing);
    }
    return new Map(
      [...destinations.entries()]
        .map(([name, urls]) => [name, urls.push ?? urls.fetch] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    );
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
    const args = hasUpstream ? ['push'] : ['push', '-u', '--', 'origin', `refs/heads/${ref}:refs/heads/${ref}`];
    await this.runGit(args, repoRoot, { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
  }

  public async pushToRemoteBranch(
    repoRoot: string,
    remoteName: string,
    localBranchName: string,
    remoteBranchName: string,
    setUpstream: boolean,
  ): Promise<void> {
    const remote = validateGitRef(remoteName);
    const local = validateGitRef(localBranchName);
    const remoteBranch = validateGitRef(remoteBranchName);
    await this.runGit(
      [
        'push',
        ...(setUpstream ? ['-u'] : []),
        '--',
        remote,
        `refs/heads/${local}:refs/heads/${remoteBranch}`,
      ],
      repoRoot,
      { timeoutMs: NETWORK_GIT_TIMEOUT_MS },
    );
  }

  public async checkoutBranch(repoRoot: string, branchName: string): Promise<void> {
    const ref = validateGitRef(branchName);
    // Trailing `--` forces Git to treat the name as a revision, never as a pathspec.
    await this.runGit(['checkout', ref, '--'], repoRoot);
  }

  public async createBranch(
    repoRoot: string,
    branchName: string,
    startPoint?: string,
    options?: CreateBranchOptions,
  ): Promise<void> {
    const ref = validateGitRef(branchName);
    const validatedStart = startPoint === undefined
      ? undefined
      : isValidCommitHash(startPoint)
        ? startPoint.toLowerCase()
        : validateGitRef(startPoint);
    const checkout = options?.checkout ?? true;

    if (!checkout) {
      const args = ['branch'];
      if (validatedStart !== undefined) {
        args.push(options?.track ? '--track' : '--no-track', ref, validatedStart);
      } else {
        args.push(ref);
      }
      await this.runGit(args, repoRoot);
      return;
    }

    const args = ['checkout', '-b', ref];
    if (validatedStart !== undefined) {
      if (options?.track !== undefined) {
        args.push(options.track ? '--track' : '--no-track', validatedStart);
      } else {
        args.push(validatedStart, '--');
      }
    } else {
      args.push('--');
    }
    await this.runGit(args, repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async hasWorkingTreeChanges(repoRoot: string): Promise<boolean> {
    return (await this.runGit(['status', '--porcelain=v1'], repoRoot)).trim().length > 0;
  }

  public async resolveCommitHash(repoRoot: string, ref: string): Promise<string | null> {
    const validated = ref === 'HEAD'
      ? 'HEAD'
      : isValidCommitHash(ref)
        ? ref.toLowerCase()
        : validateGitRef(ref);
    try {
      const hash = (await this.runGit(['rev-parse', '--verify', `${validated}^{commit}`], repoRoot)).trim().toLowerCase();
      return isValidCommitHash(hash) ? hash : null;
    } catch {
      return null;
    }
  }

  public async stashChanges(repoRoot: string, message: string): Promise<void> {
    const safeMessage = message.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || 'Auto-stash';
    await this.stashPush(repoRoot, { message: safeMessage, includeUntracked: true });
  }

  public async discardWorkingTreeChanges(repoRoot: string): Promise<void> {
    await this.runGit(['reset', '--hard', 'HEAD'], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
    await this.runGit(['clean', '-fd'], repoRoot, { timeoutMs: WORKTREE_GIT_TIMEOUT_MS });
  }

  public async renameLocalBranch(repoRoot: string, oldName: string, newName: string): Promise<void> {
    const oldRef = validateGitRef(oldName);
    const newRef = validateGitRef(newName);
    if (oldRef === newRef) {
      throw new Error('New branch name must be different from the current name.');
    }
    await this.runGit(['branch', '-m', '--', oldRef, newRef], repoRoot);
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

  public async unsetBranchUpstream(repoRoot: string, branchName: string): Promise<void> {
    const branch = validateGitRef(branchName);
    await this.runGit(['branch', '--unset-upstream', branch], repoRoot);
  }

  public async addRemote(repoRoot: string, remoteName: string, remoteUrl: string): Promise<void> {
    const remote = validateGitRef(remoteName);
    const url = remoteUrl.trim();
    const destinationKind = classifyRemoteDestination(url).kind;
    if (
      url.length === 0 ||
      url.startsWith('-') ||
      /[\x00-\x1f\x7f]/.test(url) ||
      (/\s/.test(url) && destinationKind !== 'localPath') ||
      /^ext::/i.test(url)
    ) {
      throw new Error('Enter a safe remote URL or path without whitespace, control characters, or ext:: transport.');
    }
    await this.runGit(['remote', 'add', '--', remote, url], repoRoot);
  }

  public async initBareRepository(targetDir: string, initialBranch?: string): Promise<void> {
    const target = targetDir.trim();
    if (target.length === 0 || /[\x00-\x1f\x7f]/.test(target)) {
      throw new Error('Bare repository path must not be empty or contain control characters.');
    }
    const branch = initialBranch === undefined ? undefined : validateGitRef(initialBranch);
    await this.assertBareTargetIsUnused(target);
    await fs.promises.mkdir(target, { recursive: true });
    await this.assertBareTargetIsUnused(target);
    await this.runGit(
      ['init', '--bare', ...(branch === undefined ? [] : [`--initial-branch=${branch}`])],
      target,
    );
  }

  private async assertBareTargetIsUnused(targetDir: string): Promise<void> {
    for (const marker of ['.git', 'HEAD']) {
      try {
        await fs.promises.lstat(path.join(targetDir, marker));
        throw new Error(`Refusing to overwrite an existing repository at "${targetDir}".`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Refusing to overwrite')) {
          throw err;
        }
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }
  }

  public async getRemoteRawUrl(repoRoot: string, remoteName: string): Promise<string | null> {
    const remote = validateGitRef(remoteName);
    try {
      return (await this.runGit(['remote', 'get-url', '--', remote], repoRoot)).trim() || null;
    } catch (err) {
      if (err instanceof GitExecutionError && err.code === 'COMMAND_FAILED') {
        return null;
      }
      throw err;
    }
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

  public async getRemoteUrl(repoRoot: string, preferredRemote?: string): Promise<string | null> {
    if (preferredRemote !== undefined) {
      return this.getRemoteRawUrl(repoRoot, preferredRemote);
    }

    try {
      const originUrl = (await this.runGit(['remote', 'get-url', 'origin'], repoRoot)).trim();
      if (originUrl && parseRemoteHostInfo(originUrl) !== null) {
        return originUrl;
      }
    } catch (err) {
      if (!(err instanceof GitExecutionError && err.code === 'COMMAND_FAILED')) {
        throw err;
      }
    }

    const output = await this.runGit(['remote', '-v'], repoRoot);
    const urls = output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([name, url]) => ({ name: name ?? '', url: url ?? '' }))
      .filter((candidate) => parseRemoteHostInfo(candidate.url) !== null);
    return (urls.find((candidate) => candidate.name === 'origin') ?? urls[0])?.url ?? null;
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
