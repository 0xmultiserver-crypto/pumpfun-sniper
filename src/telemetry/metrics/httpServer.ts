/**
 * Metrics HTTP Server
 *
 * Exposes Prometheus metrics over HTTP for scraping.
 *
 * Endpoints:
 *   GET /metrics → Prometheus text format
 *   GET /health → {status: 'ok', uptime}
 *
 * Default port: 9090 (configurable via METRICS_PORT env var)
 */

import * as http from 'node:http';
import { getMetrics, getContentType } from './prometheus.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('telemetry:metrics:http');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 9_090;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let server: http.Server | null = null;
const startedAt = Date.now();

/**
 * Start the metrics HTTP server.
 *
 * @param port  Port number (default: METRICS_PORT env or 9090).
 */
export function startMetricsServer(port?: number): void {
  if (server !== null) {
    logger.warn('Metrics server already running');
    return;
  }

  const resolvedPort = port ?? (process.env['METRICS_PORT'] !== undefined
    ? parseInt(process.env['METRICS_PORT'], 10)
    : DEFAULT_PORT);

  server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/metrics' || url === '/metrics/') {
      try {
        const metrics = await getMetrics();
        res.writeHead(200, { 'Content-Type': getContentType() });
        res.end(metrics);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Error generating metrics', { error: msg });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    if (url === '/health' || url === '/health/') {
      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(resolvedPort, () => {
    logger.info('Metrics HTTP server started', { port: resolvedPort });
  });

  server.on('error', (err: Error) => {
    logger.error('Metrics HTTP server error', { error: err.message });
  });
}

/**
 * Stop the metrics HTTP server (for graceful shutdown).
 */
export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server === null) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      logger.info('Metrics HTTP server stopped');
      resolve();
    });
  });
}
