import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { execGit } from '../src/git/gitExecutor';
import type { RepoGitRunner } from '../src/git/repoDiscovery';
import { canonicalizeRepoPath, discoverWorkspaceRepositories, inspectRepository } from '../src/git/repoDiscovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true }),
  ));
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repo-discovery-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('repository discovery', () => {
  it('normalizes Windows path separators and drive casing', () => {
    expect(canonicalizeRepoPath('C:\\Work\\Repo\\', 'C:\\base', 'win32')).toBe('c:\\work\\repo');
  });

  it('reads branch metadata and falls back to a detached short SHA', async () => {
    const directory = await tempDirectory();
    const attached: RepoGitRunner = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return `${directory}\n.git\n`;
      }
      if (args[0] === 'symbolic-ref') {
        return 'refs/heads/feature/x\n';
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    await expect(inspectRepository(directory, attached)).resolves.toMatchObject({
      repoRoot: canonicalizeRepoPath(await fs.promises.realpath(directory)),
      currentBranch: 'feature/x',
      isDetachedHead: false,
    });

    const detached: RepoGitRunner = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return `${directory}\n.git\n`;
      }
      if (args[0] === 'rev-parse') {
        return 'a1b2c3d\n';
      }
      throw new Error('detached');
    };
    await expect(inspectRepository(directory, detached)).resolves.toMatchObject({
      currentBranch: 'a1b2c3d',
      isDetachedHead: true,
    });
  });

  it('discovers shallow repositories, skips ignored directories, and deduplicates worktrees', async () => {
    const root = await tempDirectory();
    const primary = path.join(root, 'primary');
    const worktree = path.join(root, 'worktree');
    const nested = path.join(root, 'group', 'nested');
    const tooDeep = path.join(root, 'group', 'nested', 'too-deep');
    const ignored = path.join(root, 'node_modules', 'ignored');
    for (const directory of [primary, worktree, nested, tooDeep, ignored]) {
      await fs.promises.mkdir(path.join(directory, '.git'), { recursive: true });
    }

    const runner: RepoGitRunner = async (args, cwd) => {
      if (args[0] === 'symbolic-ref') {
        return 'refs/heads/main\n';
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        const isWorktree = cwd === worktree;
        return `${cwd}\n${isWorktree ? path.join(primary, '.git') : '.git'}\n`;
      }
      return 'abc1234\n';
    };

    const repositories = await discoverWorkspaceRepositories([], root, runner);
    const expected = await Promise.all([nested, primary].map(async (directory) =>
      canonicalizeRepoPath(await fs.promises.realpath(directory)),
    ));
    expected.sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'base' }),
    );
    expect(repositories.map((repo) => repo.repoRoot)).toEqual(expected);
    expect(repositories.some((repo) => repo.repoRoot === canonicalizeRepoPath(worktree))).toBe(false);
    expect(repositories.some((repo) => repo.repoRoot === canonicalizeRepoPath(tooDeep))).toBe(false);
    expect(repositories.some((repo) => repo.repoRoot === canonicalizeRepoPath(ignored))).toBe(false);
  });

  it('deduplicates a real linked worktree and keeps the primary repository', async () => {
    const root = await tempDirectory();
    const primary = path.join(root, 'primary');
    const linked = path.join(root, 'linked');
    await fs.promises.mkdir(primary);
    await execGit(['init', '--initial-branch=main'], primary);
    await execGit(['config', 'user.name', 'Test User'], primary);
    await execGit(['config', 'user.email', 'test@example.com'], primary);
    await fs.promises.writeFile(path.join(primary, 'tracked.txt'), 'content\n');
    await execGit(['add', 'tracked.txt'], primary);
    await execGit(['commit', '-m', 'initial'], primary);
    await execGit(['worktree', 'add', '-b', 'linked-branch', linked], primary);

    const repositories = await discoverWorkspaceRepositories([], root);
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.repoRoot).toBe(canonicalizeRepoPath(await fs.promises.realpath(primary)));
    expect(repositories[0]?.commonDir).toBe(
      canonicalizeRepoPath(await fs.promises.realpath(path.join(primary, '.git'))),
    );
  });

  it('scans only depth one and two, skipping .git, node_modules, and non-Git folders', async () => {
    const root = await tempDirectory();
    const depthOne = path.join(root, 'one');
    const depthTwo = path.join(root, 'group', 'two');
    const depthThree = path.join(root, 'group', 'two', 'three');
    for (const directory of [depthOne, depthTwo, depthThree, path.join(root, 'node_modules', 'hidden')]) {
      await fs.promises.mkdir(directory, { recursive: true });
      await execGit(['init', '--initial-branch=main'], directory);
    }
    await fs.promises.mkdir(path.join(root, 'ordinary', 'child'), { recursive: true });

    const repositories = await discoverWorkspaceRepositories([], root);
    expect(repositories.map((repo) => path.basename(repo.repoRoot))).toEqual(['one', 'two']);
  });

  it('sorts repositories case-insensitively by name and then root', async () => {
    const root = await tempDirectory();
    const paths = ['zeta', 'parent-z/alpha', 'parent-a/Alpha', 'beta'];
    const runner: RepoGitRunner = async (args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return `${cwd}\n.git\n`;
      }
      if (args[0] === 'symbolic-ref') {
        return 'refs/heads/main\n';
      }
      return 'abc1234\n';
    };
    for (const name of paths) {
      await fs.promises.mkdir(path.join(root, name, '.git'), { recursive: true });
    }

    const repositories = await discoverWorkspaceRepositories([], root, runner);
    expect(repositories.map((repo) => repo.repoName.toLowerCase())).toEqual(['alpha', 'alpha', 'beta', 'zeta']);
    expect(repositories.slice(0, 2).map((repo) => repo.repoRoot)).toEqual(
      repositories.slice(0, 2).map((repo) => repo.repoRoot).sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: 'base' }),
      ),
    );
  });

  it('reports a short hash and detached state for a real detached HEAD', async () => {
    const root = await tempDirectory();
    await execGit(['init', '--initial-branch=main'], root);
    await execGit(['config', 'user.name', 'Test User'], root);
    await execGit(['config', 'user.email', 'test@example.com'], root);
    await fs.promises.writeFile(path.join(root, 'tracked.txt'), 'content\n');
    await execGit(['add', 'tracked.txt'], root);
    await execGit(['commit', '-m', 'initial'], root);
    await execGit(['checkout', '--detach'], root);

    const repositories = await discoverWorkspaceRepositories([root]);
    expect(repositories[0]).toMatchObject({ isDetachedHead: true });
    expect(repositories[0]?.currentBranch).toMatch(/^[0-9a-f]{7,}$/);
  });
});
