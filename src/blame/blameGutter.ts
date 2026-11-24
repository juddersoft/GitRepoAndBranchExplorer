import type { BlameLineInfo, FileBlameMap } from '../git/blameParser';

export type BlameAgeBucket = 'uncommitted' | 'age0' | 'age1' | 'age2' | 'age3' | 'age4';

export const BLAME_AGE_BUCKETS: readonly BlameAgeBucket[] = [
  'uncommitted',
  'age0',
  'age1',
  'age2',
  'age3',
  'age4',
];

export const DEFAULT_GUTTER_WIDTH = 32;

export interface BlameGutterEntry {
  lineNumber: number;
  bucket: BlameAgeBucket;
  label: string;
  isHunkStart: boolean;
  info: BlameLineInfo;
}

export function computeAgeBucket(
  authorTime: number,
  minTime: number,
  maxTime: number,
  isUncommitted: boolean,
): BlameAgeBucket {
  if (isUncommitted || !Number.isFinite(authorTime) || authorTime <= 0) {
    return 'uncommitted';
  }
  if (maxTime <= minTime) {
    return 'age0';
  }

  const ratio = (maxTime - authorTime) / (maxTime - minTime);
  const normalized = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const bucketIndex = Math.min(4, Math.floor(normalized * 5));
  return `age${bucketIndex}` as Exclude<BlameAgeBucket, 'uncommitted'>;
}

function compactAgeToken(authorTime: number, nowMs: number): string {
  if (!Number.isFinite(authorTime) || authorTime <= 0 || !Number.isFinite(nowMs)) {
    return 'now';
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - authorTime * 1000) / 1000));
  if (elapsedSeconds < 60) {
    return 'now';
  }
  if (elapsedSeconds < 3600) {
    return `${Math.floor(elapsedSeconds / 60)}m`;
  }
  if (elapsedSeconds < 86_400) {
    return `${Math.floor(elapsedSeconds / 3600)}h`;
  }
  if (elapsedSeconds < 2_592_000) {
    return `${Math.floor(elapsedSeconds / 86_400)}d`;
  }
  if (elapsedSeconds < 31_536_000) {
    return `${Math.floor(elapsedSeconds / 2_592_000)}mo`;
  }
  return `${Math.min(99, Math.floor(elapsedSeconds / 31_536_000))}y`;
}

function normalizedWidth(width: number): number {
  return Math.max(12, Number.isFinite(width) ? Math.floor(width) : DEFAULT_GUTTER_WIDTH);
}

function fixedGutterText(text: string, width: number): string {
  const sliced = text.length > width ? text.slice(0, width) : text;
  return sliced.padEnd(width, '\u00A0').replace(/ /g, '\u00A0');
}

export function formatGutterLabel(
  info: BlameLineInfo,
  nowMs: number = Date.now(),
  width: number = DEFAULT_GUTTER_WIDTH,
): string {
  const targetWidth = normalizedWidth(width);
  if (info.isUncommitted) {
    return fixedGutterText('Not Committed Yet', targetWidth);
  }

  const shortHash = info.shortHash;
  const compactTime = compactAgeToken(info.authorTime, nowMs);
  const authorWidth = targetWidth - shortHash.length - compactTime.length - 2;
  let author = info.author;
  if (author.length > authorWidth) {
    author = authorWidth > 0
      ? `${author.slice(0, Math.max(0, authorWidth - 1))}…`
      : '';
  }

  const label = author.length > 0
    ? `${shortHash} ${author} ${compactTime}`
    : `${shortHash} ${compactTime}`;
  return fixedGutterText(label, targetWidth);
}

function syntheticUncommittedInfo(lineNumber: number): BlameLineInfo {
  return {
    lineNumber,
    originalLineNumber: lineNumber,
    hash: '0'.repeat(40),
    shortHash: '',
    isUncommitted: true,
    author: 'Not Committed Yet',
    authorEmail: '',
    authorTime: 0,
    authorTz: '',
    summary: '',
    filename: '',
  };
}

export function buildBlameGutterEntries(
  blameMap: FileBlameMap,
  totalLines: number,
  isDirty: boolean,
  nowMs: number = Date.now(),
  width: number = DEFAULT_GUTTER_WIDTH,
): BlameGutterEntry[] {
  void isDirty;
  const lineCount = Number.isFinite(totalLines) ? Math.floor(totalLines) : 0;
  if (lineCount <= 0) {
    return [];
  }

  let minTime = Number.POSITIVE_INFINITY;
  let maxTime = Number.NEGATIVE_INFINITY;
  for (const info of blameMap.values()) {
    if (!info.isUncommitted && info.authorTime > 0 && Number.isFinite(info.authorTime)) {
      minTime = Math.min(minTime, info.authorTime);
      maxTime = Math.max(maxTime, info.authorTime);
    }
  }
  if (minTime === Number.POSITIVE_INFINITY) {
    minTime = 0;
    maxTime = 0;
  }

  const targetWidth = normalizedWidth(width);
  const continuationLabel = '\u00A0'.repeat(targetWidth);
  const entries: BlameGutterEntry[] = [];
  let previousCommitKey: string | undefined;
  for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
    const info = blameMap.get(lineNumber) ?? syntheticUncommittedInfo(lineNumber);
    const commitKey = info.isUncommitted ? '__uncommitted__' : info.hash;
    const isHunkStart = lineNumber === 1 || commitKey !== previousCommitKey;
    entries.push({
      lineNumber,
      bucket: computeAgeBucket(info.authorTime, minTime, maxTime, info.isUncommitted),
      label: isHunkStart
        ? formatGutterLabel(info, nowMs, targetWidth)
        : continuationLabel,
      isHunkStart,
      info,
    });
    previousCommitKey = commitKey;
  }
  return entries;
}
