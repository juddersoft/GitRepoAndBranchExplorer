import type { FileBlameMap } from '../git/blameParser';
import { formatRelativeTime } from '../git/blameParser';

export type InsightSymbolKind =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'constructor'
  | 'struct'
  | 'enum'
  | 'module'
  | 'namespace';

export interface SimpleDocumentSymbol {
  readonly name: string;
  readonly kind: InsightSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly selectionLine: number;
  readonly children?: readonly SimpleDocumentSymbol[];
}

export interface SymbolBlameInsight {
  readonly name: string;
  readonly kind: InsightSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly selectionLine: number;
  readonly commitCount: number;
  readonly authorCount: number;
  readonly authors: readonly string[];
  readonly lastModifiedAuthor: string;
  readonly lastModifiedTime: number;
  readonly lastModifiedHash: string;
  readonly lastModifiedShortHash: string;
  readonly lastModifiedSummary: string;
  readonly hasUncommittedChanges: boolean;
}

export function flattenInsightSymbols(
  symbols: readonly SimpleDocumentSymbol[],
): SimpleDocumentSymbol[] {
  const supportedKinds = new Set<InsightSymbolKind>([
    'class',
    'interface',
    'function',
    'method',
    'constructor',
    'struct',
    'enum',
    'module',
    'namespace',
  ]);
  const flattened: SimpleDocumentSymbol[] = [];

  const visit = (symbol: SimpleDocumentSymbol): void => {
    if (
      supportedKinds.has(symbol.kind) &&
      symbol.startLine >= 1 &&
      symbol.endLine >= symbol.startLine
    ) {
      flattened.push(symbol);
    }
    for (const child of symbol.children ?? []) {
      visit(child);
    }
  };

  for (const symbol of symbols) {
    visit(symbol);
  }

  const bySelectionLine = new Map<number, SimpleDocumentSymbol>();
  for (const symbol of flattened) {
    const existing = bySelectionLine.get(symbol.selectionLine);
    if (
      existing === undefined ||
      symbol.startLine < existing.startLine ||
      (
        symbol.startLine === existing.startLine &&
        symbol.endLine - symbol.startLine < existing.endLine - existing.startLine
      )
    ) {
      bySelectionLine.set(symbol.selectionLine, symbol);
    }
  }

  return [...bySelectionLine.values()].sort((left, right) =>
    left.startLine - right.startLine ||
    (left.endLine - left.startLine) - (right.endLine - right.startLine));
}

export function findEnclosingSymbol(
  symbols: readonly SimpleDocumentSymbol[],
  lineNumber: number,
): SimpleDocumentSymbol | null {
  let result: SimpleDocumentSymbol | null = null;
  for (const symbol of flattenInsightSymbols(symbols)) {
    if (lineNumber < symbol.startLine || lineNumber > symbol.endLine) {
      continue;
    }
    if (
      result === null ||
      symbol.endLine - symbol.startLine < result.endLine - result.startLine
    ) {
      result = symbol;
    }
  }
  return result;
}

export function computeSymbolInsight(
  symbol: SimpleDocumentSymbol,
  blameMap: FileBlameMap,
): SymbolBlameInsight | null {
  const committedHashes = new Set<string>();
  const authorLatestTimes = new Map<string, number>();
  let linesFound = 0;
  let latestCommitted = null as {
    author: string;
    time: number;
    hash: string;
    shortHash: string;
    summary: string;
  } | null;
  let hasUncommittedChanges = false;

  for (let line = symbol.startLine; line <= symbol.endLine; line++) {
    const info = blameMap.get(line);
    if (info === undefined) {
      continue;
    }
    linesFound++;
    if (info.isUncommitted) {
      hasUncommittedChanges = true;
      continue;
    }

    if (info.hash.length > 0) {
      committedHashes.add(info.hash);
    }
    if (info.author.trim().length > 0) {
      authorLatestTimes.set(
        info.author,
        Math.max(authorLatestTimes.get(info.author) ?? Number.NEGATIVE_INFINITY, info.authorTime),
      );
    }
    if (latestCommitted === null || info.authorTime > latestCommitted.time) {
      latestCommitted = {
        author: info.author,
        time: info.authorTime,
        hash: info.hash,
        shortHash: info.shortHash,
        summary: info.summary,
      };
    }
  }

  if (linesFound === 0) {
    return null;
  }

  const authors = [...authorLatestTimes.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([author]) => author);
  const hasOnlyUncommittedChanges = committedHashes.size === 0 && hasUncommittedChanges;

  return {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    selectionLine: symbol.selectionLine,
    commitCount: committedHashes.size,
    authorCount: authors.length,
    authors,
    lastModifiedAuthor: latestCommitted?.author ?? 'You',
    lastModifiedTime: latestCommitted?.time ?? 0,
    lastModifiedHash: latestCommitted?.hash ?? '',
    lastModifiedShortHash: latestCommitted?.shortHash ?? '',
    lastModifiedSummary: latestCommitted?.summary ??
      (hasOnlyUncommittedChanges ? 'Not committed yet' : ''),
    hasUncommittedChanges,
  };
}

export function formatSymbolInsightSummary(
  insight: SymbolBlameInsight,
  nowMs: number = Date.now(),
): string {
  if (insight.commitCount === 0 && insight.hasUncommittedChanges) {
    return 'Uncommitted symbol';
  }

  const authors = `${insight.authorCount} author${insight.authorCount === 1 ? '' : 's'}`;
  const commits = `${insight.commitCount} commit${insight.commitCount === 1 ? '' : 's'}`;
  const summary = `${authors} • ${commits} • last modified by ${insight.lastModifiedAuthor} ${formatRelativeTime(insight.lastModifiedTime, nowMs)}`;
  return insight.hasUncommittedChanges ? `${summary} • uncommitted edits` : summary;
}

export function formatSymbolInsightCompact(
  insight: SymbolBlameInsight,
  nowMs: number = Date.now(),
): string {
  if (insight.commitCount === 0 && insight.hasUncommittedChanges) {
    return 'Uncommitted';
  }

  const authors = `${insight.authorCount} author${insight.authorCount === 1 ? '' : 's'}`;
  const commits = `${insight.commitCount} commit${insight.commitCount === 1 ? '' : 's'}`;
  return `${authors} • ${commits} • ${insight.lastModifiedAuthor}, ${formatRelativeTime(insight.lastModifiedTime, nowMs)}`;
}
