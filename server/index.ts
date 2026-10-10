// Production/dev entry point: one HTTP server hosting the Next.js app and the /ws realtime gateway.
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { loadEnv } from '../scripts/env';
loadEnv();
process.env.WORLDSTATE_PROCESS ??= 'web';

const { default: next } = await import('next');
const { RealtimeHub } = await import('@/server/realtime');
const { log, reportError } = await import('@/server/log');

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler();

const hub = new RealtimeHub();
await hub.start();
(globalThis as { __worldstateHub?: InstanceType<typeof RealtimeHub> }).__worldstateHub = hub;

const server = createServer((req, res) => {
  handle(req, res, parse(req.url ?? '/', true)).catch((err) => {
    reportError(err, { url: req.url });
    res.statusCode = 500;
    res.end('Internal server error');
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    hub.handleUpgrade(req, socket, head).catch((err) => { reportError(err); socket.destroy(); });
  } else {
    nextUpgrade(req, socket, head);
  }
});

server.listen(port, hostname, () => log.info(`WORLDSTATE listening on http://${hostname}:${port}`, { dev }));

async function shutdown() {
  log.info('shutting down');
  server.close();
  await hub.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
