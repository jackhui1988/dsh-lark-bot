import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GuiWorkspaceRegistry,
  loadGuiWorkspaces,
  resolveGuiWorkspace,
} from '../../src/workspace/gui-registry.js';

async function makeHome(document: unknown | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gui-registry-'));
  await mkdir(join(home, 'storages'), { recursive: true });
  if (document !== undefined) {
    await writeFile(
      join(home, 'storages', 'workspace.json'),
      typeof document === 'string' ? document : JSON.stringify(document),
    );
  }
  return home;
}

describe('loadGuiWorkspaces', () => {
  it('reads registry order from global.workspaceIds and skips path-less rows', async () => {
    const home = await makeHome({
      global: { workspaceIds: ['b', 'a', 'ghost', 'c'] },
      tables: {
        workspaces: {
          a: { title: 'Jack', path: '/data/projects/Jack' },
          b: { title: 'sissi', path: '/data/projects/sissi' },
          c: { title: 'no-path' },
        },
      },
    });
    try {
      const list = await loadGuiWorkspaces(home);
      expect(list.map((workspace) => workspace.id)).toEqual(['b', 'a']);
      expect(list[0]).toEqual({ id: 'b', title: 'sissi', path: '/data/projects/sissi' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('appends rows missing from global.workspaceIds so nothing is hidden', async () => {
    const home = await makeHome({
      global: { workspaceIds: ['a'] },
      tables: {
        workspaces: {
          a: { title: 'A', path: '/a' },
          z: { title: 'Z', path: '/z' },
        },
      },
    });
    try {
      const list = await loadGuiWorkspaces(home);
      expect(list.map((workspace) => workspace.id)).toEqual(['a', 'z']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the document is missing, malformed, or empty', async () => {
    const missing = await makeHome(undefined);
    const malformed = await makeHome('{not json');
    const empty = await makeHome({});
    try {
      expect(await loadGuiWorkspaces(missing)).toEqual([]);
      expect(await loadGuiWorkspaces(malformed)).toEqual([]);
      expect(await loadGuiWorkspaces(empty)).toEqual([]);
    } finally {
      await Promise.all(
        [missing, malformed, empty].map((home) => rm(home, { recursive: true, force: true })),
      );
    }
  });
});

describe('resolveGuiWorkspace', () => {
  const list = [
    { id: '1', title: 'dsh', path: '/data/projects/dsh' },
    { id: '2', title: 'sissi', path: '/data/projects/sissi' },
    { id: '3', title: 'sissi_paper', path: '/data/projects/sissi_paper' },
    { id: '4', title: 'Jack', path: '/data/projects/Jack' },
  ];

  it('resolves 1-based indexes', () => {
    expect(resolveGuiWorkspace(list, '1')?.id).toBe('1');
    expect(resolveGuiWorkspace(list, '4')?.id).toBe('4');
    expect(resolveGuiWorkspace(list, '0')).toBeUndefined();
    expect(resolveGuiWorkspace(list, '5')).toBeUndefined();
  });

  it('prefers an exact title over a prefix', () => {
    expect(resolveGuiWorkspace(list, 'sissi')?.id).toBe('2');
  });

  it('matches a unique case-insensitive prefix and rejects ambiguous ones', () => {
    expect(resolveGuiWorkspace(list, 'jac')?.id).toBe('4');
    expect(resolveGuiWorkspace(list, 'sissi_')?.id).toBe('3');
    expect(resolveGuiWorkspace(list, 'si')).toBeUndefined();
    expect(resolveGuiWorkspace(list, 'nope')).toBeUndefined();
  });
});

describe('GuiWorkspaceRegistry', () => {
  it('caches within the TTL so repeated commands do not re-read the file', async () => {
    const home = await makeHome({
      global: { workspaceIds: ['a'] },
      tables: { workspaces: { a: { title: 'A', path: '/a' } } },
    });
    try {
      const registry = new GuiWorkspaceRegistry(home, 60_000);
      expect((await registry.list()).map((workspace) => workspace.id)).toEqual(['a']);
      await writeFile(
        join(home, 'storages', 'workspace.json'),
        JSON.stringify({
          global: { workspaceIds: ['b'] },
          tables: { workspaces: { b: { title: 'B', path: '/b' } } },
        }),
      );
      expect((await registry.list()).map((workspace) => workspace.id)).toEqual(['a']);
      const fresh = new GuiWorkspaceRegistry(home, 0);
      expect((await fresh.list()).map((workspace) => workspace.id)).toEqual(['b']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
