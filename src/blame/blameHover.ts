import type { BlameLineInfo } from '../git/blameParser';
import { escapeMarkdownText, formatRelativeTime } from '../git/blameParser';
import {
  formatSymbolInsightSummary,
  type SymbolBlameInsight,
} from './symbolInsights';

export const BLAME_HOVER_COMMANDS = {
  revealCommitInTimeline: 'gitRepoAndBranchExplorer.revealCommitInTimeline',
  openBlameFileDiff: 'gitRepoAndBranchExplorer.openBlameFileDiff',
  copyCommitHash: 'gitRepoAndBranchExplorer.copyCommitHash',
  openCommitOnGitHub: 'gitRepoAndBranchExplorer.openCommitOnGitHub',
} as const;

export const BLAME_HOVER_ALLOWED_COMMANDS: readonly string[] = Object.values(BLAME_HOVER_COMMANDS);

export interface BlameHoverContext {
  info: BlameLineInfo;
  repoRoot: string;
  relativePath: string;
  githubRemoteUrl?: string;
  nowMs?: number;
  symbolInsight?: SymbolBlameInsight;
}

export function buildCommandUri(commandId: string, args: unknown): string {
  return `command:${commandId}?${encodeURIComponent(JSON.stringify([args]))}`;
}

function formatExactDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return 'unknown date';
  }
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toISOString();
}

export function buildBlameHoverMarkdown(ctx: BlameHoverContext): string {
  const { info } = ctx;
  const appendSymbolInsight = (base: string): string => {
    const insight = ctx.symbolInsight;
    if (insight === undefined) {
      return base;
    }
    const symbolIcon = insight.kind === 'class' ||
      insight.kind === 'struct' ||
      insight.kind === 'interface' ||
      insight.kind === 'enum'
      ? 'symbol-class'
      : insight.kind === 'module' || insight.kind === 'namespace'
        ? 'symbol-namespace'
        : 'symbol-method';
    const summary = escapeMarkdownText(formatSymbolInsightSummary(insight, ctx.nowMs));
    const lines = [
      '---',
      `**$(${symbolIcon}) \`${escapeMarkdownText(insight.name)}\`** — ${summary}`,
    ];
    if (insight.lastModifiedHash.length > 0 && insight.lastModifiedHash !== info.hash) {
      lines.push(
        `[Reveal Latest Symbol Commit](${buildCommandUri(
          BLAME_HOVER_COMMANDS.revealCommitInTimeline,
          { hash: insight.lastModifiedHash, repoRoot: ctx.repoRoot },
        )})`,
      );
    }
    return `${base}\n\n${lines.join('  \n')}`;
  };

  if (info.isUncommitted) {
    return appendSymbolInsight('**Not Committed Yet**  \nThis line has local uncommitted changes.');
  }

  const relativeTime = formatRelativeTime(info.authorTime, ctx.nowMs);
  const exactDate = formatExactDate(info.authorTime);
  const shortHash = escapeMarkdownText(info.shortHash);
  const author = escapeMarkdownText(info.author);
  const authorEmail = escapeMarkdownText(info.authorEmail);
  const filename = escapeMarkdownText(info.filename);
  const previousFilename = info.previousFilename === undefined
    ? undefined
    : escapeMarkdownText(info.previousFilename);
  const summary = escapeMarkdownText(info.summary);

  const revealArgs = { hash: info.hash };
  const diffArgs = {
    repoRoot: ctx.repoRoot,
    hash: info.hash,
    filePath: info.filename || ctx.relativePath,
    ...(info.previousFilename === undefined ? {} : { previousFilename: info.previousFilename }),
  };
  const actions = [
    `[Reveal in Commit Timeline](${buildCommandUri(BLAME_HOVER_COMMANDS.revealCommitInTimeline, revealArgs)})`,
    `[Open File Diff](${buildCommandUri(BLAME_HOVER_COMMANDS.openBlameFileDiff, diffArgs)})`,
    `[Copy Commit Hash](${buildCommandUri(BLAME_HOVER_COMMANDS.copyCommitHash, { hash: info.hash })})`,
  ];
  if (ctx.githubRemoteUrl !== undefined) {
    actions.push(
      `[Open on GitHub](${buildCommandUri(BLAME_HOVER_COMMANDS.openCommitOnGitHub, { hash: info.hash })})`,
    );
  }

  const details = [
    `**$(git-commit) \`${shortHash}\`** — **${author}** (${relativeTime}, ${exactDate})`,
    summary,
  ];
  void authorEmail;
  void filename;
  void previousFilename;
  return appendSymbolInsight(`${details.join('  \n')}\n\n${actions.join(' | ')}`);
}
