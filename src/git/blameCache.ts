import * as path from 'path';
import type { FileBlameMap } from './blameParser';

export const DEFAULT_BLAME_CACHE_MAX_ENTRIES = 30;

export interface BlameCacheKey {
  repoRoot: string;
  relativePath: string;
  ignoreWhitespace: boolean;
}

interface NormalizedBlameCacheKey {
  serialized: string;
  repoRoot: string;
}

interface CacheEntry {
  repoRoot: string;
  value: FileBlameMap;
}

interface InFlightEntry {
  repoRoot: string;
  promise: Promise<FileBlameMap | null>;
}

function normalizeRepoRoot(repoRoot: string): string {
  const windowsPath = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(repoRoot) || /^\\\\/.test(repoRoot);
  const pathApi = windowsPath ? path.win32 : path.posix;
  const resolved = pathApi.resolve(repoRoot);
  const root = pathApi.parse(resolved).root;
  const trimmed = resolved === root ? resolved : resolved.replace(/[\\/]+$/, '');
  return windowsPath ? trimmed.toLowerCase().replace(/\\/g, '/') : trimmed;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const resolved = path.posix.normalize(normalized);
  const trimmed = resolved.replace(/\/+$/, '').replace(/^\.\/+/, '');
  const withoutDot = trimmed === '.' ? '' : trimmed;
  return process.platform === 'win32' ? withoutDot.toLowerCase() : withoutDot;
}

function normalizeKey(key: BlameCacheKey): NormalizedBlameCacheKey {
  const repoRoot = normalizeRepoRoot(key.repoRoot);
  const relativePath = normalizeRelativePath(key.relativePath);
  return {
    serialized: `${repoRoot}\0${relativePath}\0${key.ignoreWhitespace ? '1' : '0'}`,
    repoRoot,
  };
}

export class BlameCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly maxEntries: number;
  private generation = 0;

  constructor(maxEntries: number = DEFAULT_BLAME_CACHE_MAX_ENTRIES) {
    this.maxEntries = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
  }

  public get(key: BlameCacheKey): FileBlameMap | undefined {
    const normalized = normalizeKey(key).serialized;
    const entry = this.entries.get(normalized);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(normalized);
    this.entries.set(normalized, entry);
    return entry.value;
  }

  public set(key: BlameCacheKey, value: FileBlameMap): void {
    const normalized = normalizeKey(key);
    this.entries.delete(normalized.serialized);
    this.entries.set(normalized.serialized, { repoRoot: normalized.repoRoot, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  public getOrLoad(
    key: BlameCacheKey,
    loader: () => Promise<FileBlameMap | null>,
  ): Promise<FileBlameMap | null> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const normalized = normalizeKey(key);
    const existing = this.inFlight.get(normalized.serialized);
    if (existing !== undefined) {
      return existing.promise;
    }

    const loadGeneration = this.generation;
    let promise!: Promise<FileBlameMap | null>;
    promise = (async () => {
      try {
        const value = await loader();
        if (value !== null && loadGeneration === this.generation) {
          this.set(key, value);
        }
        return value;
      } finally {
        if (this.inFlight.get(normalized.serialized)?.promise === promise) {
          this.inFlight.delete(normalized.serialized);
        }
      }
    })();
    this.inFlight.set(normalized.serialized, { repoRoot: normalized.repoRoot, promise });
    return promise;
  }

  public invalidateFile(repoRoot: string, relativePath: string): void {
    const normalizedRoot = normalizeRepoRoot(repoRoot);
    const falseKey = normalizeKey({ repoRoot: normalizedRoot, relativePath, ignoreWhitespace: false }).serialized;
    const trueKey = normalizeKey({ repoRoot: normalizedRoot, relativePath, ignoreWhitespace: true }).serialized;
    this.entries.delete(falseKey);
    this.entries.delete(trueKey);
    this.inFlight.delete(falseKey);
    this.inFlight.delete(trueKey);
    this.generation++;
  }

  public invalidateRepo(repoRoot: string): void {
    const normalizedRoot = normalizeRepoRoot(repoRoot);
    for (const [key, entry] of this.entries) {
      if (entry.repoRoot === normalizedRoot) {
        this.entries.delete(key);
      }
    }
    for (const [key, entry] of this.inFlight) {
      if (entry.repoRoot === normalizedRoot) {
        this.inFlight.delete(key);
      }
    }
    this.generation++;
  }

  public clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.generation++;
  }

  public get size(): number {
    return this.entries.size;
  }
}
