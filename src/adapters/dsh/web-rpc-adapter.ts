import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types.js';
import { detectImageType } from '../../media/image-file.js';
import { translateSessionEvent } from './sdk-translate.js';
import { EventChannel } from './event-channel.js';
import { log } from '../../core/logger.js';

/** Canonical session log basenames, newest generation first. */
const SESSION_LOG_FILES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd'] as const;
/** zstd frame magic; a session log is a concatenation of whole frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_POLL_MS = 1_000;
const RPC_TIMEOUT_MS = 30_000;

export interface WebRpcAdapterOptions {
  /** Base URL of the local dsh web instance (default `http://127.0.0.1:3080`). */
  baseUrl: string;
  /** `$DSH_HOME` whose `sessions/` tree holds the session logs this adapter tails. */
  dshHome: string;
  provider?: string;
  model: string | undefined;
  /** Log poll interval; lower values trade CPU for finer card updates. */
  pollIntervalMs?: number;
}

interface RpcResult<T> {
  ok?: boolean;
  value?: T;
  error?: { message?: string };
}

/**
 * Drive the **host dsh web instance** as the session owner.
 *
 * The web server is the single writer of its sessions, which is exactly what
 * GUI workspace grouping and GUI-side continuation require: a session created
 * through `session/create` belongs to the web, shows up under its workspace,
 * and stays resumable from the browser. The bridge stays a client:
 *
 * - `session/create` (optionally with the `/ws`-selected `workspaceId`, which
 *   attaches the session to that workspace's roster)
 * - `session/prompt` in queue mode for each bridge turn
 * - `session/cancel` for `/stop`
 * - the session log under `$DSH_HOME/sessions/**` is tailed for progress, so
 *   the streaming card keeps working without re-implementing the gateway's
 *   Remote stream protocol.
 *
 * Approval prompts raised by the host are answered in the GUI (the bridge has
 * no approval channel on this path); the plan-gate still runs bridge-side.
 */
export class WebRpcDshAdapter implements AgentAdapter {
  readonly id = 'dsh-web-rpc';
  readonly displayName = 'DeepSeek Harness (Web GUI, RPC)';
  readonly resumeCapable = true;

  private readonly baseUrl: string;
  private readonly dshHome: string;
  private readonly model: string | undefined;
  private readonly pollIntervalMs: number;
  private disposed = false;

  constructor(options: WebRpcAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.dshHome = options.dshHome;
    this.model = options.model;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    if (this.disposed) return { ok: false, error: 'adapter disposed', version: undefined };
    try {
      const response = await fetch(`${this.baseUrl}/`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok
        ? { ok: true, error: undefined, version: `dsh-web@${this.baseUrl}` }
        : { ok: false, error: `HTTP ${String(response.status)}`, version: undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        version: undefined,
      };
    }
  }

  /**
   * The web instance owns the session, so a stored binding can always be
   * resumed — there is no per-process runtime to lose ownership to.
   */
  canResume(): boolean {
    return !this.disposed;
  }

  run(options: AgentRunOptions): AgentRun {
    const stopRequested = { value: false };
    const handle = this.runTurn(options, stopRequested);
    return {
      runId: options.runId,
      events: handle.events,
      stop: async (): Promise<void> => {
        stopRequested.value = true;
        await handle.cancel();
        await handle.settled;
      },
      waitForExit: (timeoutMs: number) => waitWithTimeout(handle.settled, timeoutMs),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private async rpc<T>(method: string, request: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: { args: { request } },
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`web RPC ${method} failed: HTTP ${String(response.status)}`);
    const envelope = (await response.json()) as { result?: RpcResult<T> };
    const result = envelope.result;
    if (result === undefined) throw new Error(`web RPC ${method} returned no result`);
    if (result.ok === false) {
      throw new Error(result.error?.message ?? `web RPC ${method} failed`);
    }
    return result.value as T;
  }

  private async ensureSession(options: AgentRunOptions): Promise<string> {
    if (options.sessionId !== undefined) {
      // A chat that keeps its native session but switches to a GUI workspace
      // must still end up in that workspace's roster: `session/create` with
      // both identities is the idempotent adoption (create-or-attach) the
      // gateway exposes, and the web already owns the session, so there is no
      // ownership fight. Failures only cost grouping, never the run.
      if (options.workspaceId !== undefined) {
        try {
          await this.rpc('session/create', {
            sessionId: options.sessionId,
            workspaceId: options.workspaceId,
          });
        } catch (error) {
          log.warn('web-rpc', 'attach-failed', {
            sessionId: options.sessionId,
            workspaceId: options.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return options.sessionId;
    }
    const created = await this.rpc<{ sessionId?: string }>(
      'session/create',
      options.workspaceId === undefined
        ? { cwd: options.cwd ?? process.cwd(), agentPreset: 'standard' }
        : { workspaceId: options.workspaceId, agentPreset: 'standard' },
    );
    const sessionId = created.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('web session/create returned no session id');
    }
    return sessionId;
  }

  private async promptContent(options: AgentRunOptions): Promise<unknown[]> {
    const parts: unknown[] = [{ type: 'text', text: options.prompt }];
    for (const path of options.images ?? []) {
      try {
        const [{ mediaType }, data] = await Promise.all([
          detectImageType(path),
          readFile(path),
        ]);
        parts.push({
          type: 'image',
          mediaType,
          data: data.toString('base64'),
          name: path.split('/').pop() ?? 'image',
        });
      } catch (error) {
        log.warn('web-rpc', 'image-read-failed', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return parts;
  }

  private async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.rpc('session/cancel', { sessionId });
    } catch (error) {
      log.warn('web-rpc', 'cancel-failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Locate this session's log under `$DSH_HOME/sessions/**`. */
  private async findSessionLog(sessionId: string): Promise<string | undefined> {
    let dirs: string[];
    try {
      dirs = (await readdir(join(this.dshHome, 'sessions'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      for (const name of SESSION_LOG_FILES) {
        const candidate = join(this.dshHome, 'sessions', dir, sessionId, name);
        try {
          await readFile(candidate);
          return candidate;
        } catch {
          // try the next generation / directory
        }
      }
    }
    return undefined;
  }

  private runTurn(
    options: AgentRunOptions,
    stopRequested: { value: boolean },
  ): { events: AsyncIterable<AgentEvent>; cancel: () => Promise<void>; settled: Promise<void> } {
    const channel = new EventChannel<AgentEvent>();
    let activeSessionId = options.sessionId;
    const settled = (async () => {
      const tracker = { emitted: new Set<string>() };
      try {
        activeSessionId = await this.ensureSession(options);
      } catch (error) {
        channel.push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          terminationReason: 'failed',
        });
        channel.close();
        return;
      }
      const sessionId = activeSessionId;
      channel.push({
        type: 'system',
        sessionId,
        cwd: options.cwd,
        model: options.model ?? this.model,
      });
      let logPath = await this.waitForSessionLog(sessionId);
      // Everything already in the log belongs to earlier turns: a resumed
      // session must not replay its history into this card.
      let cursor = 0;
      if (logPath !== undefined) {
        try {
          cursor = decodeSessionLog(await readFile(logPath)).length;
        } catch {
          cursor = 0;
        }
      }
      try {
        await this.rpc('session/prompt', {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: await this.promptContent(options),
        });
      } catch (error) {
        channel.push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          terminationReason: 'failed',
        });
        channel.close();
        return;
      }
      let finished = false;
      while (!finished) {
        if (stopRequested.value) {
          await this.cancelSession(sessionId);
          channel.push({ type: 'done', sessionId, terminationReason: 'interrupted' });
          break;
        }
        logPath = logPath ?? (await this.findSessionLog(sessionId));
        if (logPath !== undefined) {
          try {
            const events = decodeSessionLog(await readFile(logPath));
            for (const event of events.slice(cursor)) {
              const failed = translateSessionEvent(event, tracker).filter(
                (translated) => translated.type === 'error',
              );
              if (failed.length > 0) {
                for (const translated of failed) channel.push(translated);
                finished = true;
                break;
              }
              const record = event as { type?: unknown };
              if (record.type === 'turn/end') {
                channel.push({ type: 'done', sessionId, terminationReason: 'normal' });
                finished = true;
                break;
              }
              for (const translated of translateSessionEvent(event, tracker)) {
                channel.push(translated);
              }
            }
            cursor = events.length;
          } catch (error) {
            log.warn('web-rpc', 'log-read-failed', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!finished) await delay(this.pollIntervalMs);
      }
      channel.close();
    })().catch((error: unknown) => {
      channel.push({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        terminationReason: 'failed',
      });
      channel.close();
    });
    return {
      events: channel,
      cancel: async () => {
        if (activeSessionId !== undefined) await this.cancelSession(activeSessionId);
      },
      settled: settled.then(() => undefined),
    };
  }

  /** Wait briefly for a freshly created session's log file to appear. */
  private async waitForSessionLog(sessionId: string): Promise<string | undefined> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const path = await this.findSessionLog(sessionId);
      if (path !== undefined || Date.now() >= deadline) return path;
      await delay(200);
    }
  }
}

/**
 * Decode one session log. Harness logs append whole zstd frames, so the buffer
 * is split on the frame magic and each candidate frame is decoded on its own;
 * candidates that do not decode are skipped (a magic sequence can occur inside
 * compressed data).
 */
export function decodeSessionLog(buffer: Buffer): unknown[] {
  const output: Buffer[] = [];
  const starts: number[] = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    starts.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length);
  }
  if (starts.length === 0) return [];
  for (let frame = 0; frame < starts.length; frame += 1) {
    const slice = buffer.subarray(starts[frame], starts[frame + 1] ?? buffer.length);
    try {
      output.push(zstdDecompressSync(slice));
    } catch {
      // not a frame boundary after all
    }
  }
  const text = Buffer.concat(output).toString('utf8');
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      // a partially flushed line; the next poll re-reads the frame
    }
  }
  return events;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  return Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

