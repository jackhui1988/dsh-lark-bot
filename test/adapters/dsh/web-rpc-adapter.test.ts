import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  WebRpcDshAdapter,
  decodeSessionLog,
} from '../../../src/adapters/dsh/web-rpc-adapter.js';
import type { AgentEvent } from '../../../src/adapters/types.js';

const SESSION_ID = 'session-0123456789abcdef0123456789abcdef';
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function frame(event: unknown): Buffer {
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`));
}

async function makeHome(): Promise<{ home: string; logPath: string }> {
  const home = await mkdtemp(join(tmpdir(), 'web-rpc-home-'));
  roots.push(home);
  const dir = join(home, 'sessions', '--tmp--', SESSION_ID);
  await mkdir(dir, { recursive: true });
  const logPath = join(dir, 'session.v3.jsonl.zstd');
  await writeFile(logPath, frame({ type: 'session', version: 3, id: SESSION_ID }));
  return { home, logPath };
}

interface Stub {
  baseUrl: string;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
}

async function startGateway(
  onPrompt: (logPath: string) => void,
  logPath: string,
): Promise<Stub> {
  const calls: Stub['calls'] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      if (url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html></html>');
        return;
      }
      const method = url.replace('/api/', '');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      calls.push({ method, body });
      const value =
        method === 'session/create'
          ? { sessionId: SESSION_ID, agentPreset: 'standard' }
          : { accepted: true };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: '1', result: { ok: true, value } }));
      if (method === 'session/prompt') onPrompt(logPath);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${String(port)}`, calls };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('decodeSessionLog', () => {
  it('decodes concatenated zstd frames and skips non-frame magics', () => {
    const buffer = Buffer.concat([
      frame({ type: 'session', version: 3 }),
      frame({ type: 'turn/start', data: { turn: 1 } }),
      frame({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    ]);
    const events = decodeSessionLog(buffer) as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual(['session', 'turn/start', 'turn/end']);
  });

  it('returns nothing for an empty or undecodable buffer', () => {
    expect(decodeSessionLog(Buffer.alloc(0))).toEqual([]);
    expect(decodeSessionLog(Buffer.from('not zstd'))).toEqual([]);
  });
});

describe('WebRpcDshAdapter', () => {
  it('creates a GUI-owned session, prompts it, and streams the logged turn', async () => {
    const { home, logPath } = await makeHome();
    const gateway = await startGateway((path) => {
      void (async () => {
        await appendFile(path, frame({ type: 'turn/start', data: { turn: 1, step: 0 } }));
        await appendFile(
          path,
          frame({
            type: 'assistant/message',
            data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] } },
          }),
        );
        await appendFile(path, frame({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }));
      })();
    }, logPath);
    const adapter = new WebRpcDshAdapter({
      baseUrl: gateway.baseUrl,
      dshHome: home,
      model: undefined,
      pollIntervalMs: 25,
    });
    const run = adapter.run({
      runId: 'run-1',
      prompt: 'ping',
      cwd: '/tmp',
      sessionId: undefined,
      workspaceId: 'ws-jack',
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const events = await collect(run.events);
    expect(events[0]).toEqual({ type: 'system', sessionId: SESSION_ID, cwd: '/tmp', model: undefined });
    expect(events).toContainEqual({ type: 'final_text', content: 'PONG' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: SESSION_ID, terminationReason: 'normal' });

    const create = gateway.calls.find((call) => call.method === 'session/create');
    expect(create?.body).toMatchObject({
      method: 'session/create',
      payload: { args: { request: { workspaceId: 'ws-jack', agentPreset: 'standard' } } },
    });
    const prompt = gateway.calls.find((call) => call.method === 'session/prompt');
    expect(prompt?.body).toMatchObject({
      payload: {
        args: {
          request: {
            sessionId: SESSION_ID,
            mode: 'queue',
            content: [{ type: 'text', text: 'ping' }],
          },
        },
      },
    });
  });

  it('falls back to the cwd when no GUI workspace is selected', async () => {
    const { home, logPath } = await makeHome();
    const gateway = await startGateway((path) => {
      void appendFile(path, frame({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }));
    }, logPath);
    const adapter = new WebRpcDshAdapter({ baseUrl: gateway.baseUrl, dshHome: home, model: undefined, pollIntervalMs: 25 });
    const run = adapter.run({
      runId: 'run-2',
      prompt: 'ping',
      cwd: '/data/projects/lark',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    await collect(run.events);
    expect(gateway.calls.find((call) => call.method === 'session/create')?.body).toMatchObject({
      payload: { args: { request: { cwd: '/data/projects/lark', agentPreset: 'standard' } } },
    });
  });

  it('surfaces an error when the gateway rejects the prompt', async () => {
    const { home } = await makeHome();
    const calls: string[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = request.url ?? '';
        if (url === '/') {
          response.writeHead(200);
          response.end('ok');
          return;
        }
        const method = url.replace('/api/', '');
        calls.push(method);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          method === 'session/prompt'
            ? JSON.stringify({ result: { ok: false, error: { message: 'agent is busy' } } })
            : JSON.stringify({ result: { ok: true, value: { sessionId: SESSION_ID } } }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const adapter = new WebRpcDshAdapter({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      dshHome: home,
      model: undefined,
      pollIntervalMs: 25,
    });
    const run = adapter.run({
      runId: 'run-3',
      prompt: 'ping',
      cwd: '/tmp',
      sessionId: undefined,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const events = await collect(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'agent is busy', terminationReason: 'failed' });
  });

  it('cancels the session when the run is stopped', async () => {
    const { home } = await makeHome();
    const gateway = await startGateway(() => undefined, join(home, 'unused'));
    const adapter = new WebRpcDshAdapter({ baseUrl: gateway.baseUrl, dshHome: home, model: undefined, pollIntervalMs: 25 });
    const run = adapter.run({
      runId: 'run-4',
      prompt: 'ping',
      cwd: '/tmp',
      sessionId: SESSION_ID,
      model: undefined,
      images: undefined,
      stopGraceMs: undefined,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next(); // system event
    await run.stop();
    const remaining: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      remaining.push(next.value);
    }
    expect(remaining.at(-1)).toEqual({ type: 'done', sessionId: SESSION_ID, terminationReason: 'interrupted' });
    expect(gateway.calls.some((call) => call.method === 'session/cancel')).toBe(true);
  });
});
