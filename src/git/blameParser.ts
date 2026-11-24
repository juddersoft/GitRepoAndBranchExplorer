const BLAME_HEADER_PATTERN = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (\d+)(?: (\d+))?$/i;

export interface BlameLineInfo {
  lineNumber: number;
  originalLineNumber: number;
  hash: string;
  shortHash: string;
  isUncommitted: boolean;
  author: string;
  authorEmail: string;
  authorTime: number;
  authorTz: string;
  summary: string;
  filename: string;
  sourceLine?: string;
  previousHash?: string;
  previousFilename?: string;
}

export type FileBlameMap = ReadonlyMap<number, BlameLineInfo>;

interface BlameCommitMetadata {
  author?: string;
  authorEmail?: string;
  authorTime?: number;
  authorTz?: string;
  summary?: string;
  filename?: string;
  previousHash?: string;
  previousFilename?: string;
}

interface PendingBlameBlock extends BlameCommitMetadata {
  hash: string;
  originalLineNumber: number;
  lineNumber: number;
}

export function isUncommittedHash(hash: string): boolean {
  return /^0{40}(?:0{24})?$/.test(hash);
}

function parsePositiveLineNumber(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseAuthorTime(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function stripEmailBrackets(value: string): string {
  return value.replace(/[<>]/g, '').trim();
}

function mergeMetadata(
  target: BlameCommitMetadata,
  source: BlameCommitMetadata,
): BlameCommitMetadata {
  return {
    author: source.author ?? target.author,
    authorEmail: source.authorEmail ?? target.authorEmail,
    authorTime: source.authorTime ?? target.authorTime,
    authorTz: source.authorTz ?? target.authorTz,
    summary: source.summary ?? target.summary,
    filename: source.filename ?? target.filename,
    previousHash: source.previousHash ?? target.previousHash,
    previousFilename: source.previousFilename ?? target.previousFilename,
  };
}

function finishPendingBlock(
  pending: PendingBlameBlock,
  metadataByHash: ReadonlyMap<string, BlameCommitMetadata>,
  result: Map<number, BlameLineInfo>,
  sourceLine: string,
): void {
  const metadata = mergeMetadata(metadataByHash.get(pending.hash) ?? {}, pending);
  const uncommitted = isUncommittedHash(pending.hash);
  const author = uncommitted || metadata.author === undefined || metadata.author.length === 0
    ? 'Not Committed Yet'
    : metadata.author;

  result.set(pending.lineNumber, {
    lineNumber: pending.lineNumber,
    originalLineNumber: pending.originalLineNumber,
    hash: pending.hash,
    shortHash: uncommitted ? '' : pending.hash.slice(0, 8),
    isUncommitted: uncommitted,
    author,
    authorEmail: stripEmailBrackets(metadata.authorEmail ?? ''),
    authorTime: metadata.authorTime ?? 0,
    authorTz: metadata.authorTz ?? '',
    summary: metadata.summary ?? '',
    filename: metadata.filename ?? '',
    sourceLine,
    ...(metadata.previousHash !== undefined ? { previousHash: metadata.previousHash } : {}),
    ...(metadata.previousFilename !== undefined ? { previousFilename: metadata.previousFilename } : {}),
  });
}

export function parseBlamePorcelain(output: string): FileBlameMap {
  const result = new Map<number, BlameLineInfo>();
  const metadataByHash = new Map<string, BlameCommitMetadata>();
  let pending: PendingBlameBlock | null = null;

  for (const line of output.split(/\r?\n/)) {
    const header = BLAME_HEADER_PATTERN.exec(line);
    if (header !== null) {
      const hash = (header[1] ?? '').toLowerCase();
      const originalLineNumber = parsePositiveLineNumber(header[2] ?? '');
      const lineNumber = parsePositiveLineNumber(header[3] ?? '');
      pending =
        originalLineNumber === null || lineNumber === null
          ? null
          : { hash, originalLineNumber, lineNumber };
      continue;
    }

    if (/^[0-9a-f]{40,64}\s/i.test(line)) {
      pending = null;
      continue;
    }

    if (pending === null) {
      continue;
    }

    if (line.startsWith('\t')) {
      finishPendingBlock(pending, metadataByHash, result, line.slice(1));
      pending = null;
      continue;
    }

    const value = line.includes(' ') ? line.slice(line.indexOf(' ') + 1) : '';
    if (line.startsWith('author ')) {
      pending.author = value;
    } else if (line.startsWith('author-mail ')) {
      pending.authorEmail = stripEmailBrackets(value);
    } else if (line.startsWith('author-time ')) {
      pending.authorTime = parseAuthorTime(value);
    } else if (line.startsWith('author-tz ')) {
      pending.authorTz = value;
    } else if (line.startsWith('summary ')) {
      pending.summary = value;
    } else if (line.startsWith('filename ')) {
      pending.filename = value;
    } else if (line.startsWith('previous ')) {
      const previous = /^previous ([0-9a-f]{40}(?:[0-9a-f]{24})?) (.*)$/i.exec(line);
      if (previous !== null) {
        pending.previousHash = (previous[1] ?? '').toLowerCase();
        pending.previousFilename = previous[2] ?? '';
      }
    }

    if (
      pending.author !== undefined ||
      pending.authorEmail !== undefined ||
      pending.authorTime !== undefined ||
      pending.authorTz !== undefined ||
      pending.summary !== undefined ||
      pending.filename !== undefined ||
      pending.previousHash !== undefined
    ) {
      metadataByHash.set(
        pending.hash,
        mergeMetadata(metadataByHash.get(pending.hash) ?? {}, pending),
      );
    }
  }

  return result;
}

export function formatRelativeTime(epochSeconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return 'unknown';
  }
  if (!Number.isFinite(nowMs)) {
    nowMs = Date.now();
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - epochSeconds * 1000) / 1000));
  if (elapsedSeconds < 60) {
    return 'just now';
  }
  if (elapsedSeconds < 3600) {
    const minutes = Math.floor(elapsedSeconds / 60);
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsedSeconds < 86_400) {
    const hours = Math.floor(elapsedSeconds / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (elapsedSeconds < 2_592_000) {
    const days = Math.floor(elapsedSeconds / 86_400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  if (elapsedSeconds < 31_536_000) {
    const months = Math.floor(elapsedSeconds / 2_592_000);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(elapsedSeconds / 31_536_000);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function formatInlineBlame(
  info: BlameLineInfo,
  nowMs: number = Date.now(),
  maxSummaryLength = 50,
): string {
  if (info.isUncommitted) {
    return 'Not Committed Yet';
  }

  const relativeTime = formatRelativeTime(info.authorTime, nowMs);
  if (info.summary.length === 0) {
    return `${info.author}, ${relativeTime}`;
  }

  const limit = Number.isFinite(maxSummaryLength) ? Math.max(0, Math.floor(maxSummaryLength)) : 50;
  const summary = info.summary.length > limit
    ? `${info.summary.slice(0, Math.max(0, limit - 1))}…`
    : info.summary;
  return summary.length > 0 ? `${info.author}, ${relativeTime} • ${summary}` : `${info.author}, ${relativeTime}`;
}

export function escapeMarkdownText(text: string): string {
  return text.replace(/[\r\n]/g, ' ').replace(/[\\[\]()*_`<>#~|]/g, '\\$&');
}
