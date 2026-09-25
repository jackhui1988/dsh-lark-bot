import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryHandleCommand, type CommandContext } from '../../src/commands/index.js';
import { ActiveRuns } from '../../src/bot/active-runs.js';
import { SessionStore } from '../../src/session/store.js';
import { WorkspaceStore } from '../../src/workspace/store.js';
import type { GuiWorkspace } from '../../src/workspace/gui-registry.js';

const roots: string[] = [];
const flushes: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(flushes.splice(0).map((flush) => flush()));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

const GUI_LIST: GuiWorkspace[] = [
  { id: 'ws-dsh', title: 'dsh', path: '/data/projects/dsh' },
  { id: 'ws-jack', title: 'Jack', path: '/data/projects/Jack' },
];

interface Harness {
  ctx: CommandContext;
  sendMarkdown: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  workspaces: WorkspaceStore;
  sessions: SessionStore;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ws-gui-'));
  roots.push(root);
  const workspaces = new WorkspaceStore(join(root, 'workspaces.json'));
  const sessions = new SessionStore(join(root, 'sessions.json'));
  await Promise.all([workspaces.load(), sessions.load()]);
  flushes.push(async () => Promise.all([workspaces.flush(), sessions.flush()]).then(() => undefined));
  workspaces.setCwd('chat-a', '/data/projects/dsh');
  const sendMarkdown = vi.fn().mockResolvedValue(undefined);
  const adopt = vi.fn().mockResolvedValue({ ok: true });
  const ctx = {
    scope: 'chat-a',
    chatId: 'chat-a',
    messageId: 'om_1',
    threadId: undefined,
    chatMode: 'p2p',
    sessions,
    workspaces,
    activeRuns: new ActiveRuns(),
    defaultWorkspace: '/data/projects/dsh',
    channel: { sendMarkdown } as unknown as CommandContext['channel'],
    guiWorkspaces: { list: async () => GUI_LIST },
    guiAdopter: { adopt },
  } as unknown as CommandContext;
  return { ctx, sendMarkdown, adopt, workspaces, sessions };
}

describe('/ws with the host GUI registry', () => {
  it('lists GUI workspaces with 1-based indexes in the text fallback', async () => {
    const { ctx, sendMarkdown } = await makeHarness();
    expect(await tryHandleCommand('/ws list', ctx)).toBe(true);
    const text = sendMarkdown.mock.calls[0]?.[1] as string;
    expect(text).toContain('1. **dsh** → `/data/projects/dsh`');
    expect(text).toContain('2. **Jack** → `/data/projects/Jack`');
    // The named-alias section survives alongside the GUI section.
    expect(text).toContain('命名工作空间');
  });

  it('switches by index and binds the GUI workspace without adopting when no session exists yet', async () => {
    const { ctx, adopt, workspaces } = await makeHarness();
    await tryHandleCommand('/ws 2', ctx);
    expect(workspaces.cwdFor('chat-a')).toBe('/data/projects/Jack');
    expect(workspaces.getGuiBinding('chat-a')).toEqual({
      workspaceId: 'ws-jack',
      workspacePath: '/data/projects/Jack',
      adoptedSessionId: undefined,
    });
    expect(adopt).not.toHaveBeenCalled();
  });

  it('adopts an existing session for that workspace when switching', async () => {
    const { ctx, adopt, workspaces, sessions } = await makeHarness();
    sessions.set('chat-a', 'session-existing', '/data/projects/Jack');
    await tryHandleCommand('/ws Jack', ctx);
    expect(adopt).toHaveBeenCalledWith('session-existing', 'ws-jack');
    expect(workspaces.getGuiBinding('chat-a')?.adoptedSessionId).toBe('session-existing');
  });

  it('keeps the adopted marker when adoption fails so the next turn retries', async () => {
    const { ctx, adopt, workspaces, sessions, sendMarkdown } = await makeHarness();
    adopt.mockResolvedValueOnce({ ok: false, error: 'its cwd resolves to something else' });
    sessions.set('chat-a', 'session-existing', '/data/projects/Jack');
    await tryHandleCommand('/ws use Jack', ctx);
    expect(workspaces.getGuiBinding('chat-a')?.adoptedSessionId).toBeUndefined();
    const text = sendMarkdown.mock.calls[0]?.[1] as string;
    expect(text).toContain('its cwd resolves to something else');
  });

  it('resolves named aliases when the GUI registry has no match', async () => {
    const { ctx, workspaces } = await makeHarness();
    workspaces.saveNamed('legacy', '/data/projects/legacy');
    await tryHandleCommand('/ws use legacy', ctx);
    expect(workspaces.cwdFor('chat-a')).toBe('/data/projects/legacy');
    expect(workspaces.getGuiBinding('chat-a')).toBeUndefined();
  });

  it('reports an out-of-range index without switching', async () => {
    const { ctx, workspaces, sendMarkdown } = await makeHarness();
    await tryHandleCommand('/ws 9', ctx);
    expect(workspaces.cwdFor('chat-a')).toBe('/data/projects/dsh');
    expect(sendMarkdown.mock.calls[0]?.[1] as string).toContain('序号超范围');
  });

  it('drops the GUI binding when a plain /cd replaces the entry', async () => {
    const { ctx, workspaces } = await makeHarness();
    await tryHandleCommand('/ws 2', ctx);
    expect(workspaces.getGuiBinding('chat-a')).toBeDefined();
    workspaces.setCwd('chat-a', '/tmp/elsewhere');
    expect(workspaces.getGuiBinding('chat-a')).toBeUndefined();
  });
});
