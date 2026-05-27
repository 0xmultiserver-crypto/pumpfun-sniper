/**
 * Union-Find (Disjoint Set Union) data structure.
 *
 * Supports path compression and union-by-rank for near-constant amortised
 * operations.  Elements are identified by arbitrary string keys — calling
 * find() or union() on a key that has not been seen before will lazily
 * register it.
 */

export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  /**
   * Find the representative (root) of the set containing `x`.
   * Lazily registers `x` if it has not been seen before.
   * Applies path compression for subsequent lookups.
   */
  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }

    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }

    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }

    return root;
  }

  /**
   * Merge the sets containing `a` and `b`.
   * Uses union-by-rank to keep the tree shallow.
   * Returns the representative of the merged set.
   */
  union(a: string, b: string): string {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;

    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;

    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
      return rootB;
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
      return rootA;
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
      return rootA;
    }
  }

  /**
   * Return a map of representative → Set of all elements in that group.
   * Only groups with `minSize` or more elements are included.
   */
  getClusters(minSize = 1): Map<string, Set<string>> {
    const groups = new Map<string, Set<string>>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      let group = groups.get(root);
      if (group === undefined) {
        group = new Set();
        groups.set(root, group);
      }
      group.add(key);
    }
    if (minSize > 1) {
      for (const [root, group] of groups) {
        if (group.size < minSize) {
          groups.delete(root);
        }
      }
    }
    return groups;
  }

  /**
   * Return an array of Sets, each containing the elements of one connected
   * component.  Only components with `minSize` or more elements are included.
   */
  getConnectedComponents(minSize = 1): Array<Set<string>> {
    return [...this.getClusters(minSize).values()];
  }
}
