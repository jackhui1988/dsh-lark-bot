import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One host (DSH GUI) workspace from the durable registry. */
export interface GuiWorkspace {
  id: string;
  title: string;
  path: string;
}

interface WorkspaceRegistryRow {
  title?: string;
  path?: string;
}

interface WorkspaceRegistryDoc {
  global?: { workspaceIds?: string[] };
  tables?: { workspaces?: Record<string, WorkspaceRegistryRow> };
}

/**
 * Read the host GUI's workspace registry (`$DSH_HOME/storages/workspace.json`)
 * in the registry's own stable order. A missing or malformed document yields an
 * empty list: the bridge must keep working without the GUI present.
 */
export async function loadGuiWorkspaces(dshHome: string): Promise<GuiWorkspace[]> {
  let doc: WorkspaceRegistryDoc;
  try {
    doc = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')) as WorkspaceRegistryDoc;
  } catch {
    return [];
  }
  const rows = doc.tables?.workspaces ?? {};
  const ids = (doc.global?.workspaceIds ?? Object.keys(rows)).filter((id) => id in rows);
  for (const id of Object.keys(rows)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids
    .map((id) => ({ id, title: rows[id]?.title ?? '', path: rows[id]?.path ?? '' }))
    .filter((workspace) => workspace.path !== '');
}

/**
 * Resolve one GUI workspace from a `/ws` argument: a 1-based index, an exact
 * title, or a unique case-insensitive title prefix. Ambiguous prefixes and
 * unknown names resolve to `undefined` so callers can fall back to aliases.
 */
export function resolveGuiWorkspace(list: readonly GuiWorkspace[], query: string): GuiWorkspace | undefined {
  if (/^\d+$/.test(query)) {
    const index = Number(query);
    return index >= 1 && index <= list.length ? list[index - 1] : undefined;
  }
  const exact = list.find((workspace) => workspace.title === query);
  if (exact !== undefined) return exact;
  const lower = query.toLowerCase();
  const prefixed = list.filter((workspace) => workspace.title.toLowerCase().startsWith(lower));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** Cached registry reader so each `/ws` invocation reads at most one file. */
export class GuiWorkspaceRegistry {
  private cache: { at: number; list: GuiWorkspace[] } | undefined;

  constructor(
    private readonly dshHome: string,
    private readonly ttlMs = 5_000,
  ) {}

  async list(): Promise<GuiWorkspace[]> {
    const now = Date.now();
    if (this.cache !== undefined && now - this.cache.at < this.ttlMs) return this.cache.list;
    const list = await loadGuiWorkspaces(this.dshHome);
    this.cache = { at: now, list };
    return list;
  }
}
