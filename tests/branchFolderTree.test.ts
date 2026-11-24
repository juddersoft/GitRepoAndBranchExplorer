import { describe, expect, it } from 'vitest';
import type { BranchInfo } from '../src/types/git';
import {
  buildBranchFolderTree,
  collectAncestorFolderIds,
  type BranchFolderNode,
  type BranchTreeNode,
} from '../src/webview/ui/branchFolderTree';

function branch(name: string, remoteName: string | null = null): BranchInfo {
  return {
    name,
    displayName: remoteName ? name.slice(remoteName.length + 1) : name,
    fullName: remoteName ? `refs/remotes/${name}` : `refs/heads/${name}`,
    isCurrent: false,
    isRemote: remoteName !== null,
    remoteName,
    tipHash: `${name.length.toString(16)}`.padEnd(40, '0'),
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
  };
}

function labels(nodes: readonly BranchTreeNode[]): string[] {
  return nodes.map((node) => node.kind === 'folder' ? `${node.name}/` : node.label);
}

function folder(nodes: readonly BranchTreeNode[], name: string): BranchFolderNode {
  const node = nodes.find((candidate): candidate is BranchFolderNode => candidate.kind === 'folder' && candidate.name === name);
  if (!node) {
    throw new Error(`Missing folder ${name}`);
  }
  return node;
}

describe('buildBranchFolderTree', () => {
  it('keeps flat names as leaves', () => {
    const tree = buildBranchFolderTree([branch('main'), branch('develop')], 'local');
    expect(labels(tree)).toEqual(['develop', 'main']);
    expect(tree).toMatchObject([
      { kind: 'branch', id: 'refs/heads/develop', label: 'develop' },
      { kind: 'branch', id: 'refs/heads/main', label: 'main' },
    ]);
  });

  it('builds single and multiple nested folder levels', () => {
    const tree = buildBranchFolderTree(
      [branch('feature/login'), branch('feature/pdj/branch_name_goes_here')],
      'local',
    );
    const feature = folder(tree, 'feature');
    const pdj = folder(feature.children, 'pdj');

    expect(labels(tree)).toEqual(['feature/']);
    expect(labels(feature.children)).toEqual(['pdj/', 'login']);
    expect(labels(pdj.children)).toEqual(['branch_name_goes_here']);
    expect(feature).toMatchObject({
      id: 'folder:local:feature',
      fullPrefix: 'feature',
      branchCount: 2,
    });
    expect(pdj).toMatchObject({
      id: 'folder:local:feature/pdj',
      fullPrefix: 'feature/pdj',
      branchCount: 1,
    });
  });

  it('strips a remote prefix before constructing folders', () => {
    const tree = buildBranchFolderTree(
      [branch('origin/feature/pdj/foo', 'origin')],
      'remote:origin',
      'origin/',
    );

    expect(labels(tree)).toEqual(['feature/']);
    expect(labels(folder(tree, 'feature').children)).toEqual(['pdj/']);
    const pdj = folder(folder(tree, 'feature').children, 'pdj');
    expect(pdj.children).toMatchObject([{ kind: 'branch', label: 'foo', branch: { name: 'origin/feature/pdj/foo' } }]);
  });

  it('sorts folders first and names case-insensitively at every level', () => {
    const tree = buildBranchFolderTree(
      [
        branch('zeta'),
        branch('alpha/zulu'),
        branch('Alpha/beta'),
        branch('feature/zebra'),
        branch('feature/Alpha'),
        branch('feature/beta'),
        branch('Beta'),
      ],
      'local',
    );

    expect(labels(tree)).toEqual(['alpha/', 'Alpha/', 'feature/', 'Beta', 'zeta']);
    expect(labels(folder(tree, 'feature').children)).toEqual(['Alpha', 'beta', 'zebra']);
  });

  it('computes recursive branch counts', () => {
    const tree = buildBranchFolderTree(
      [branch('a/one'), branch('a/b/two'), branch('a/b/c/three'), branch('flat')],
      'local',
    );
    const a = folder(tree, 'a');
    const b = folder(a.children, 'b');
    const c = folder(b.children, 'c');
    expect(a.branchCount).toBe(3);
    expect(b.branchCount).toBe(2);
    expect(c.branchCount).toBe(1);
  });

  it('defensively ignores empty path segments', () => {
    const tree = buildBranchFolderTree([branch('/feature//nested/')], 'local');
    expect(labels(tree)).toEqual(['feature/']);
    expect(folder(tree, 'feature').children).toMatchObject([{ kind: 'branch', label: 'nested' }]);
  });
});

describe('collectAncestorFolderIds', () => {
  it('returns unique ancestor ids leading to selected branches', () => {
    const one = { ...branch('feature/pdj/one'), isCurrent: true };
    const two = branch('feature/other/two');
    const three = branch('main');

    expect(
      collectAncestorFolderIds(
        [one, two, three],
        'local',
        new Set([one.fullName, two.fullName, three.fullName, 'refs/heads/missing']),
      ),
    ).toEqual([
      'folder:local:feature',
      'folder:local:feature/pdj',
      'folder:local:feature/other',
    ]);
  });

  it('uses stripped remote paths and returns no ids for flat branches', () => {
    const nested = branch('origin/release/1.6/fix', 'origin');
    const flat = branch('origin/main', 'origin');
    expect(
      collectAncestorFolderIds(
        [nested, flat],
        'remote:origin',
        new Set([nested.fullName, flat.fullName]),
        'origin/',
      ),
    ).toEqual([
      'folder:remote:origin:release',
      'folder:remote:origin:release/1.6',
    ]);
  });
});
