// The server: one Node http server wiring the four surfaces onto one store.
// main.ts owns the lifecycle (bind ephemeral port, register, wait for done);
// this file is the forge itself.
//
// Routing:
//   GET  /healthz                       the env's boot probe, no auth
//   /api/v3/...                         REST v3 (auth required)
//   POST /api/graphql                   GraphQL v4 (auth required)
//   POST /mcp                           MCP over streamable HTTP (auth required)
//   /<owner>/<repo>.git/info/refs      git smart HTTP advertisements (auth required)
//   /<owner>/<repo>.git/git-upload-pack
//   /<owner>/<repo>.git/git-receive-pack
//   anything else                       404 {"message":"Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { VIEWER_LOGIN } from './src/scenario.ts';
import { handleRest, type RestCtx } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { infoRefs, receivePack, uploadPack } from './src/git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}-${process.pid}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const m = header.match(/^Bearer (.+)$/);
  return m !== null && (m[1] as string).trim() !== '';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store(VIEWER_LOGIN);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        await handleOne(store, req, res);
      } catch (err) {
        // A request must never take the server down.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The socket is gone; nothing left to do.
        }
      }
    })();
  });
}

async function handleOne(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'bad request URL' });
    return;
  }
  const path = url.pathname;
  const segments = path.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- REST v3 ------------------------------------------------------------
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, { message: 'Request body is not valid JSON' });
        return;
      }
    }
    const ctx: RestCtx = {
      method,
      segments: segments.slice(2),
      query: url.searchParams,
      body,
      host: req.headers.host ?? '127.0.0.1',
    };
    const answer = handleRest(store, ctx);
    if (answer === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (answer.status === 204) {
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, answer.status, answer.body ?? {}, answer.headers ?? {});
    return;
  }

  // ---- GraphQL v4 ----------------------------------------------------------
  if (method === 'POST' && path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const raw = await readBody(req);
    const answer = handleGraphQL(store, raw);
    sendJson(res, answer.status, answer.body);
    return;
  }

  // ---- MCP -----------------------------------------------------------------
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // A session goodbye (the client only sends it when a session id exists;
      // this server is stateless, so there is never one to forget).
      sendEmpty(res, 204);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const answer = handleMcp(store, raw, authorized(req));
    if (answer.status === 202 || answer.body === undefined) {
      sendEmpty(res, answer.status);
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  // ---- git smart HTTP -------------------------------------------------------
  if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const repo = owner === store.viewer ? store.getRepo(owner, repoName) : undefined;
    const tail = segments.slice(2).join('/');
    if (tail === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const answer = infoRefs(store, repo, service, version2);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    if (tail === 'git-upload-pack' && method === 'POST') {
      const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const raw = await readBody(req);
      const answer = uploadPack(store, repo, raw, version2);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    if (tail === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const answer = receivePack(store, repo, raw);
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
