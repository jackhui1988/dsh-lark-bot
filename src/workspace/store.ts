import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write.js';
import { log } from '../core/logger.js';

interface ChatWorkspace {
  cwd: string;
  /**
   * Host GUI workspace this chat's cwd was selected from (`/ws <n>` /
   * `/ws use <title>`). A plain `/cd` replaces the entry and drops the
   * binding, so adoption only follows explicit GUI selections.
   */
  guiWorkspaceId?: string;
  /** Registry path behind `guiWorkspaceId`, validated against the run cwd. */
  guiWorkspacePath?: string;
}

interface WorkspaceData {
  chats: Record<string, ChatWorkspace>;
  named: Record<string, string>;
  lastUsed: Record<string, number>;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {}, lastUsed: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
        lastUsed: parsed.lastUsed ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  cwdFor(scopeId: string): string | undefined {
    return this.data.chats[scopeId]?.cwd;
  }

  setCwd(scopeId: string, cwd: string): void {
    this.data.chats[scopeId] = { cwd };
    this.schedulePersist();
  }

  removeCwd(scopeId: string): boolean {
    if (!(scopeId in this.data.chats)) return false;
    delete this.data.chats[scopeId];
    this.schedulePersist();
    return true;
  }

  /** Attach (or refresh) the GUI workspace binding of the chat's current cwd. */
  setGuiBinding(scopeId: string, workspaceId: string, workspacePath: string): void {
    const current = this.data.chats[scopeId];
    if (current === undefined) return;
    this.data.chats[scopeId] = {
      cwd: current.cwd,
      guiWorkspaceId: workspaceId,
      guiWorkspacePath: workspacePath,
    };
    this.schedulePersist();
  }

  /** The GUI workspace this chat's current cwd was selected from, if any. */
  getGuiBinding(scopeId: string): { workspaceId: string; workspacePath: string } | undefined {
    const entry = this.data.chats[scopeId];
    if (entry?.guiWorkspaceId === undefined || entry.guiWorkspacePath === undefined) return undefined;
    return { workspaceId: entry.guiWorkspaceId, workspacePath: entry.guiWorkspacePath };
  }

  listNamed(): Record<string, string> {
    return { ...this.data.named };
  }

  getNamed(name: string): string | undefined {
    return this.data.named[name];
  }

  saveNamed(name: string, cwd: string): void {
    this.data.named[name] = cwd;
    this.data.lastUsed[name] = Date.now();
    this.schedulePersist();
  }

  touchNamed(name: string): void {
    if (!(name in this.data.named)) return;
    this.data.lastUsed[name] = Date.now();
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    delete this.data.lastUsed[name];
    this.schedulePersist();
    return true;
  }

  listIndex(): Array<{ name: string; cwd: string; lastUsed: number | undefined }> {
    return Object.entries(this.data.named)
      .map(([name, cwd]) => ({ name, cwd, lastUsed: this.data.lastUsed[name] }))
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    const snapshot: WorkspaceData = {
      chats: { ...this.data.chats },
      named: { ...this.data.named },
      lastUsed: { ...this.data.lastUsed },
    };
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(snapshot, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((error: unknown) => {
        log.fail('workspace', error, { step: 'persist' });
      });
  }
}
