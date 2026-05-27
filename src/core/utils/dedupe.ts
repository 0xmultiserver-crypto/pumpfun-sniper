/**
 * Deduplication utility.
 *
 * Duplicate execution prevention is mandatory (rule.md).
 * Signal dedupe + tx dedupe.
 */

/** Time-bounded deduplication set */
export class DedupeSet {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Start automatic cleanup */
  startCleanup(intervalMs: number = 30_000): void {
    this.stopCleanup();
    this.cleanupTimer = setInterval(() => {
      this.purgeExpired();
    }, intervalMs);
  }

  /** Stop automatic cleanup */
  stopCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Check if a key has been seen recently.
   * Returns true if DUPLICATE (already seen), false if NEW.
   * Automatically adds the key if new.
   */
  isDuplicate(key: string): boolean {
    const now = Date.now();

    const existingTs = this.entries.get(key);
    if (existingTs !== undefined && now - existingTs < this.ttlMs) {
      return true;
    }

    this.entries.set(key, now);
    return false;
  }

  /** Check without adding */
  has(key: string): boolean {
    const existingTs = this.entries.get(key);
    if (existingTs === undefined) {
      return false;
    }
    return Date.now() - existingTs < this.ttlMs;
  }

  /** Remove expired entries */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts >= this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  /** Current size (including expired) */
  get size(): number {
    return this.entries.size;
  }

  /** Destroy and cleanup */
  destroy(): void {
    this.stopCleanup();
    this.entries.clear();
  }
}
