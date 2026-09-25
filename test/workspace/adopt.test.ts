import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuiWorkspaceAdopter } from '../../src/workspace/adopt.js';

interface Recorded {
  url: string;
  cookie: string | undefined;
  body: unknown;
}

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startStub(
  handler: (request: IncomingMessage, response: ServerResponse, recorded: Recorded[]) => void,
  options: { token?: string } = {},
): Promise<{ baseUrl: string; recorded: Recorded[]; home: string }> {
  const recorded: Recorded[] = [];
  const server = createServer((request, response) => handler(request, response, recorded));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const home = await mkdtemp(join(tmpdir(), 'adopt-home-'));
  roots.push(home);
  if (options.token !== undefined) await writeFile(join(home, 'web-token'), `${options.token}\n`);
  return { baseUrl: `http://127.0.0.1:${String(port)}`, recorded, home };
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        resolve(raw);
      }
    });
  });
}

describe('GuiWorkspaceAdopter', () => {
  it('calls session/create with the gateway arg envelope and reports success', async () => {
    const { baseUrl, recorded, home } = await startStub((request, response, captured) => {
      void readBody(request).then((body) => {
        captured.push({ url: request.url ?? '', cookie: request.headers.cookie, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'server-response', rpcId: '1', result: { ok: true, value: {} } }));
      });
    });
    const adopter = new GuiWorkspaceAdopter({ baseUrl, dshHome: home });
    expect(await adopter.adopt('session-abc', 'ws-jack')).toEqual({ ok: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe('/api/session/create');
    expect(recorded[0]?.body).toMatchObject({
      type: 'client-request',
      method: 'session/create',
      payload: { args: { request: { sessionId: 'session-abc', workspaceId: 'ws-jack' } } },
    });
  });

  it('surfaces the gateway error message when the adoption is rejected', async () => {
    const { baseUrl, home } = await startStub((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: '1',
          result: { ok: false, error: { code: 'x', message: 'its cwd resolves to /tmp/elsewhere' } },
        }),
      );
    });
    const adopter = new GuiWorkspaceAdopter({ baseUrl, dshHome: home });
    expect(await adopter.adopt('session-abc', 'ws-jack')).toEqual({
      ok: false,
      error: 'its cwd resolves to /tmp/elsewhere',
    });
  });

  it('reports transport failures as a soft error', async () => {
    const { baseUrl, home } = await startStub((_request, response) => {
      response.writeHead(500);
      response.end('boom');
    });
    const adopter = new GuiWorkspaceAdopter({ baseUrl, dshHome: home });
    expect(await adopter.adopt('session-abc', 'ws-jack')).toEqual({ ok: false, error: 'HTTP 500' });
  });

  it('exchanges the web-token for a cookie and reuses it', async () => {
    const { baseUrl, recorded, home } = await startStub(
      (request, response, captured) => {
        if (request.url?.startsWith('/?token=') === true) {
          response.writeHead(302, { 'set-cookie': 'dsh_session=abc; Path=/; HttpOnly' });
          response.end();
          return;
        }
        void readBody(request).then((body) => {
          captured.push({ url: request.url ?? '', cookie: request.headers.cookie, body });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ result: { ok: true } }));
        });
      },
      { token: 'token-123' },
    );
    const adopter = new GuiWorkspaceAdopter({ baseUrl, dshHome: home });
    await adopter.adopt('session-one', 'ws-a');
    await adopter.adopt('session-two', 'ws-b');
    expect(recorded.map((entry) => entry.cookie)).toEqual(['dsh_session=abc', 'dsh_session=abc']);
  });
});
