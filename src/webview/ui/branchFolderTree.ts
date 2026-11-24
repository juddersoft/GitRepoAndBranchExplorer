import type { BranchInfo } from '../../types/git';

export interface BranchFolderNode {
  kind: 'folder';
  id: string;
  name: string;
  fullPrefix: string;
  children: BranchTreeNode[];
  branchCount: number;
}

export interface BranchLeafNode {
  kind: 'branch';
  id: string;
  label: string;
  branch: BranchInfo;
}

export type BranchTreeNode = BranchFolderNode | BranchLeafNode;

function relativeBranchPath(branch: BranchInfo, stripPrefix: string | undefined): string {
  return stripPrefix && branch.name.startsWith(stripPrefix) ? branch.name.slice(stripPrefix.length) : branch.name;
}

function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

function sortNodes(nodes: BranchTreeNode[]): void {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      sortNodes(node.children);
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    const aLabel = a.kind === 'folder' ? a.name : a.label;
    const bLabel = b.kind === 'folder' ? b.name : b.label;
    return compareLabels(aLabel, bLabel);
  });
}

function countBranches(nodes: BranchTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === 'branch') {
      count += 1;
    } else {
      node.branchCount = countBranches(node.children);
      count += node.branchCount;
    }
  }
  return count;
}

export function buildBranchFolderTree(
  branches: readonly BranchInfo[],
  scopeKey: string,
  stripPrefix?: string,
): BranchTreeNode[] {
  const roots: BranchTreeNode[] = [];
  for (const branch of branches) {
    const segments = pathSegments(relativeBranchPath(branch, stripPrefix));
    if (segments.length === 0) {
      continue;
    }

    let nodes = roots;
    const folderSegments = segments.slice(0, -1);
    for (let index = 0; index < folderSegments.length; index += 1) {
      const fullPrefix = folderSegments.slice(0, index + 1).join('/');
      const id = `folder:${scopeKey}:${fullPrefix}`;
      let folder = nodes.find(
        (node): node is BranchFolderNode => node.kind === 'folder' && node.id === id,
      );
      if (!folder) {
        folder = {
          kind: 'folder',
          id,
          name: folderSegments[index],
          fullPrefix,
          children: [],
          branchCount: 0,
        };
        nodes.push(folder);
      }
      nodes = folder.children;
    }

    nodes.push({
      kind: 'branch',
      id: branch.fullName,
      label: segments[segments.length - 1],
      branch,
    });
  }

  countBranches(roots);
  sortNodes(roots);
  return roots;
}

export function collectAncestorFolderIds(
  branches: readonly BranchInfo[],
  scopeKey: string,
  targetFullNames: ReadonlySet<string>,
  stripPrefix?: string,
): string[] {
  const ids = new Set<string>();
  for (const branch of branches) {
    if (!targetFullNames.has(branch.fullName)) {
      continue;
    }
    const folderSegments = pathSegments(relativeBranchPath(branch, stripPrefix)).slice(0, -1);
    for (let index = 1; index <= folderSegments.length; index += 1) {
      ids.add(`folder:${scopeKey}:${folderSegments.slice(0, index).join('/')}`);
    }
  }
  return [...ids];
}
