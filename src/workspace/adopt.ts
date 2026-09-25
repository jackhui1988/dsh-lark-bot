import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger.js';

export interface GuiAdopterOptions {
  /** Base URL of the local dsh web instance (same host the `web` adapter uses). */
  baseUrl: string;
  /** $DSH_HOME, used to read the `web-token` bootstrap credential. */
  dshHome: string;
}

/**
 * Whether the bridge may adopt its sessions into a host GUI workspace.
 *
 * Off by default: the harness owns each Session with a single-writer lease, so
 * adopting a session that the SDK runtime still holds either fails
 * (`SessionAlreadyOwnedError`) or — when the web grabs it first — makes the
 * runtime's next prompt fail, because the runtime cannot take back a session
 * another process owns. Adoption is therefore opt-in for deployments whose
 * sessions the bridge has finished with (for example a GUI-owned `web`
 * adapter), never for the default SDK runtime.
 */
export function guiAdoptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_LARK_GUI_ADOPT === '1';
}

interface RpcEnvelope {
  result?: {
    ok?: boolean;
    value?: unknown;
    error?: { message?: string };
  };
  error?: { message?: string };
}

/**
 * Attach bridge-created sessions to the host GUI's workspace roster through
 * the local dsh web gateway's `session.create` command, which idempotently
 * adopts an existing session and validates its stored cwd against the
 * workspace path. Authentication mirrors the browser flow: exchange the
 * `$DSH_HOME/web-token` file for a session cookie once, then reuse it; a
 * missing token file means the instance runs without auth and requests go
 * out unauthenticated.
 */
export class GuiWorkspaceAdopter {
  private cookie: string | undefined;

  constructor(private readonly options: GuiAdopterOptions) {}

  private get tokenPath(): string {
    return join(this.options.dshHome, 'web-token');
  }

  private async ensureCookie(): Promise<string | undefined> {
    if (this.cookie !== undefined) return this.cookie;
    let token: string;
    try {
      token = (await readFile(this.tokenPath, 'utf8')).trim();
    } catch {
      return undefined;
    }
    if (token === '') return undefined;
    const response = await fetch(`${this.options.baseUrl}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const cookie = (response.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (cookie === '') return undefined;
    this.cookie = cookie;
    return cookie;
  }

  /**
   * Adopt one session into one GUI workspace. Disabled unless
   * `DSH_LARK_GUI_ADOPT=1`; see {@link guiAdoptionEnabled} for why. Idempotent
   * on the gateway side; failures are reported, never thrown, so the run flow
   * can log and retry on the next turn.
   */
  async adopt(sessionId: string, workspaceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!guiAdoptionEnabled()) return { ok: false, error: 'gui adoption disabled' };
    try {
      const cookie = await this.ensureCookie();
      const response = await fetch(`${this.options.baseUrl}/api/session/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `lark-adopt-${sessionId}-${workspaceId}`,
          method: 'session/create',
          payload: { args: { request: { sessionId, workspaceId } } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) {
        this.cookie = undefined;
        return { ok: false, error: `gateway auth rejected (HTTP ${String(response.status)})` };
      }
      if (!response.ok) return { ok: false, error: `HTTP ${String(response.status)}` };
      const envelope = (await response.json()) as RpcEnvelope;
      const failure = envelope.result?.error ?? envelope.error;
      if (envelope.result?.ok === false || failure !== undefined) {
        return { ok: false, error: failure?.message ?? 'session.create rejected the adoption' };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('workspace', 'gui-adopt-failed', { sessionId, workspaceId, error: message });
      return { ok: false, error: message };
    }
  }
}
