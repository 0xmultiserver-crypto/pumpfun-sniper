/**
 * Generic bounded map with insertion-order eviction.
 *
 * Wraps a native Map and enforces a maximum size. When a new entry is added
 * at capacity, the oldest entry (by insertion order) is evicted first.
 *
 * Supports an optional `preferEvict` predicate for priority-based eviction:
 * when at capacity, entries matching the predicate are evicted before any
 * non-matching entries. If no entry matches, the oldest entry is evicted
 * regardless.
 *
 * Used by blacklists and other bounded collections across the codebase.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoundedMapOptions<K, V> {
  /** Maximum number of entries. */
  readonly maxSize: number;
  /**
   * Optional eviction predicate. When the map is at capacity and a new entry
   * is being added, the oldest entry matching this predicate is evicted first.
   * If no entry matches, the oldest entry is evicted regardless.
   */
  readonly preferEvict?: (key: K, value: V) => boolean;
}

// ---------------------------------------------------------------------------
// BoundedMap
// ---------------------------------------------------------------------------

export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;
  private readonly preferEvict: ((key: K, value: V) => boolean) | null;

  constructor(options: BoundedMapOptions<K, V>) {
    this.maxSize = options.maxSize;
    this.preferEvict = options.preferEvict ?? null;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  /**
   * Add or update an entry. If the map is at capacity and the key is new,
   * the oldest entry is evicted (preferring entries that match `preferEvict`).
   *
   * Returns `true` if a new entry was inserted, `false` if the key already
   * existed (value is updated in place).
   */
  set(key: K, value: V): boolean {
    const existed = this.map.has(key);

    if (!existed && this.map.size >= this.maxSize) {
      this.evict();
    }

    this.map.set(key, value);
    return !existed;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Iterate values in insertion order. */
  values(): IterableIterator<V> {
    return this.map.values();
  }

  /** Iterate [key, value] pairs in insertion order. */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  /** Iterate keys in insertion order. */
  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  /** Snapshot of all values as an array. */
  toArray(): V[] {
    return Array.from(this.map.values());
  }

  clear(): void {
    this.map.clear();
  }

  // -- internal eviction ---------------------------------------------------

  private evict(): void {
    // If we have a preference predicate, try the oldest matching entry first
    if (this.preferEvict !== null) {
      for (const [key, value] of this.map) {
        if (this.preferEvict(key, value)) {
          this.map.delete(key);
          return;
        }
      }
    }

    // Fallback: evict the oldest entry (first in insertion order)
    const firstKey = this.map.keys().next().value;
    if (firstKey !== undefined) {
      this.map.delete(firstKey);
    }
  }
}
