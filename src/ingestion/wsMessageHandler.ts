/**
 * WebSocket Message Handler
 *
 * Parses raw Helius WebSocket messages, decodes Pump.fun events from logs,
 * and routes them through the normalizer → dispatcher pipeline.
 * Pure ingestion logic — no business decisions here.
 */

import { decodeEventFromLogs } from '../adapters/protocols/pumpfun/eventDecoder.js';
import { parseLaunchFromLogs } from '../adapters/protocols/pumpfun/launchParser.js';
import type { RawEvent } from './pipeline/eventNormalizer.js';
import type { EventNormalizer } from './pipeline/eventNormalizer.js';
import type { EventDispatcher } from './pipeline/eventDispatcher.js';
import { nowMs } from '../core/utils/time.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('ingestion:wsMessageHandler');

/**
 * Handle a raw WebSocket message from Helius.
 *
 * Parses the JSON-RPC notification, extracts logs/slot/signature, decodes
 * the Pump.fun event, and dispatches a normalized event.
 *
 * @param raw        - Raw message buffer/string from the WebSocket.
 * @param normalizer - EventNormalizer instance for transforming raw events.
 * @param dispatcher - EventDispatcher instance for routing events to detectors.
 */
export function handleWsMessage(
  raw: string,
  normalizer: EventNormalizer,
  dispatcher: EventDispatcher,
): void {
  try {
    const message = JSON.parse(raw) as Record<string, unknown>;
    const params = message['params'] as Record<string, unknown> | undefined;
    if (!params) return;
    const result = params['result'] as Record<string, unknown> | undefined;
    if (!result) return;
    const value = result['value'] as Record<string, unknown> | undefined;
    if (!value) return;
    const logs = value['logs'] as string[] | undefined;
    const slot = (result['context'] as Record<string, unknown>)?.['slot'] as number ?? 0;
    const signature = value['signature'] as string ?? '';
    if (!logs || logs.length === 0) return;

    const decoded = decodeEventFromLogs(logs, slot, signature);
    if (!decoded) {
      const hasPf = logs.some(l => l.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
      if (hasPf) {
        logger.debug('Pump.fun logs not decoded', { logCount: logs.length, sample: logs.slice(0, 5) });
      }
      return;
    }

    logger.info('Event decoded', { type: decoded.type, slot, signature: signature.slice(0, 12) });

    let dispatchType: string;
    let eventData: Record<string, unknown> = { ...decoded.data, signature };
    switch (decoded.type) {
      case 'CREATE': {
        dispatchType = 'launch';
        const launch = parseLaunchFromLogs(logs, slot, signature);
        if (launch !== null) {
          eventData = { ...eventData, ...launch };
        }
        break;
      }
      case 'BUY':
      case 'SELL':
        dispatchType = 'trade';
        eventData['isBuy'] = decoded.type === 'BUY';
        break;
      case 'MIGRATE':
        dispatchType = 'migration';
        eventData['logs'] = logs;
        break;
      default: return;
    }

    const rawEvent: RawEvent = {
      source: 'helius-ws', type: dispatchType, data: eventData,
      receivedAt: nowMs(), slot,
    };
    const normalizedEvent = normalizer.normalize(rawEvent);
    logger.info('Dispatching event', { type: normalizedEvent.type, mint: normalizedEvent.mint?.slice(0, 8) });
    void dispatcher.dispatch(normalizedEvent);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error processing WebSocket message', { error: msg });
  }
}
