/**
 * Event Dispatcher — fan-out normalized events to registered handlers.
 * Ingestion layer only: no strategy or business logic.
 */

import type { NormalizedEvent } from './eventNormalizer.js';
import { createLogger } from '../../telemetry/logging/logger.js';

// ── Types ────────────────────────────────────────────────────────────

export type EventHandler = (event: NormalizedEvent) => void | Promise<void>;

// ── Dispatcher ───────────────────────────────────────────────────────

const logger = createLogger('EventDispatcher');

export class EventDispatcher {
  /** Handlers keyed by event type. */
  private readonly handlers: Map<string, Set<EventHandler>> = new Map();

  /** Handlers that receive every event regardless of type. */
  private readonly globalHandlers: Set<EventHandler> = new Set();

  // ── Registration ─────────────────────────────────────────────────

  /** Register a handler for a specific event type. */
  on(eventType: string, handler: EventHandler): void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
  }

  /** Register a handler that receives ALL events. */
  onAll(handler: EventHandler): void {
    this.globalHandlers.add(handler);
  }

  /** Remove a previously registered handler for a specific event type. */
  off(eventType: string, handler: EventHandler): void {
    const set = this.handlers.get(eventType);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(eventType);
      }
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────

  /**
   * Dispatch a normalized event to all matching handlers and global handlers.
   * Each handler is invoked independently — one handler's failure does not
   * prevent others from running.
   */
  async dispatch(event: NormalizedEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type);
    const targets: readonly EventHandler[] = [
      ...(typeHandlers ? typeHandlers : []),
      ...this.globalHandlers,
    ];

    const settled = await Promise.allSettled(
      targets.map((handler) => Promise.resolve(handler(event))),
    );

    for (const result of settled) {
      if (result.status === 'rejected') {
        logger.error('Handler error during dispatch', {
          eventType: event.type,
          eventId: event.id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  // ── Introspection ────────────────────────────────────────────────

  /**
   * Return the number of registered handlers.
   * If `eventType` is provided, returns the count for that type only (excludes global).
   * If omitted, returns the total across all types plus global handlers.
   */
  handlerCount(eventType?: string): number {
    if (eventType !== undefined) {
      const set = this.handlers.get(eventType);
      return set ? set.size : 0;
    }

    let total = this.globalHandlers.size;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }

  /** Remove all handlers (typed and global). */
  clear(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }
}
