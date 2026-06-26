/**
 * Tiny in-process static file server for E2E test fixtures.
 *
 * Serves anything under e2e/fixtures/ on http://127.0.0.1:<port>/<filename>
 * Chrome extensions can't inject content scripts into file:// URLs, so we
 * need an HTTP origin to test against.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf':  'application/pdf',
  '.png':  'image/png',
};

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const cleanPath = url.split('?')[0].replace(/^\//, '');
    const filePath = path.resolve(FIXTURES_DIR, cleanPath);

    // Prevent path traversal
    if (!filePath.startsWith(FIXTURES_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
