/**
 * Generic LRU (Least Recently Used) cache.
 *
 * Uses a doubly-linked list + hashmap for O(1) get/set/delete.
 * When the cache exceeds `maxSize`, the least-recently-used entry is evicted.
 *
 * Exported for shared use across detectors (smart money, cabal, etc.).
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Internal doubly-linked list node. */
interface LRUNode<K, V> {
  key: K;
  value: V;
  prev: LRUNode<K, V> | null;
  next: LRUNode<K, V> | null;
}

// ---------------------------------------------------------------------------
// LRUCache
// ---------------------------------------------------------------------------

export class LRUCache<K, V> {
  private readonly map = new Map<K, LRUNode<K, V>>();
  private head: LRUNode<K, V> | null = null;
  private tail: LRUNode<K, V> | null = null;

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (node === undefined) return undefined;
    this.moveToFront(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      this.moveToFront(existing);
      return;
    }

    const node: LRUNode<K, V> = { key, value, prev: null, next: null };
    this.map.set(key, node);
    this.addToFront(node);

    while (this.map.size > this.maxSize) {
      this.evictLRU();
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  /** Iterate values in MRU → LRU order. */
  *values(): IterableIterator<V> {
    let node = this.head;
    while (node !== null) {
      yield node.value;
      node = node.next;
    }
  }

  /** Iterate entries in MRU → LRU order. */
  *entries(): IterableIterator<[K, V]> {
    let node = this.head;
    while (node !== null) {
      yield [node.key, node.value];
      node = node.next;
    }
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  // -- internal linked-list helpers --

  private moveToFront(node: LRUNode<K, V>): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToFront(node);
  }

  private addToFront(node: LRUNode<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head !== null) {
      this.head.prev = node;
    }
    this.head = node;
    if (this.tail === null) {
      this.tail = node;
    }
  }

  private removeNode(node: LRUNode<K, V>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private evictLRU(): void {
    if (this.tail === null) return;
    const victim = this.tail;
    this.removeNode(victim);
    this.map.delete(victim.key);
  }
}
