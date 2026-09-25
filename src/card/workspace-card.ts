import { localizedCard, type CardLocale } from './i18n.js';

export function renderWorkspaceCard(input: {
  current: string;
  index: Array<{ name: string; cwd: string; lastUsed: number | undefined }>;
  /** Host GUI workspaces in registry order; rendered as a numbered section. */
  gui?: Array<{ id: string; title: string; path: string }>;
}): object {
  const body = (locale: CardLocale) => {
    const entries = input.index;
    const gui = input.gui ?? [];
    const markdown = [
      locale === 'zh_cn' ? `**当前工作目录**\n\`${input.current}\`` : `**Current workspace**\n\`${input.current}\``,
      '',
      locale === 'zh_cn' ? '**GUI 工作区**（`/ws <序号>` 打开并挂组）' : '**GUI workspaces** (open & group with `/ws <index>`)',
      ...(gui.length > 0
        ? gui.map(
            (workspace, position) =>
              `${String(position + 1)}. **${workspace.title === '' ? workspace.path : workspace.title}** → \`${workspace.path}\`${workspace.path === input.current ? (locale === 'zh_cn' ? ' ← 当前' : ' ← current') : ''}`,
          )
        : [locale === 'zh_cn' ? '（未发现宿主 GUI 工作区）' : '(no host GUI workspaces found)']),
      '',
      locale === 'zh_cn' ? '**命名工作空间**（`/ws use <名称>`）' : '**Named workspaces** (`/ws use <name>`)',
      ...(entries.length > 0
        ? entries.map(({ name, cwd, lastUsed }) =>
            `- **${name}** → \`${cwd}\`${lastUsed ? ` · ${new Date(lastUsed).toLocaleString(locale === 'zh_cn' ? 'zh-CN' : 'en-US')}` : ''}`,
          )
        : [locale === 'zh_cn' ? '暂无命名工作空间。' : 'No named workspaces.']),
    ].join('\n');
    return {
      elements: [
        {
          tag: 'markdown',
          content: markdown,
        },
      ],
    };
  };
  return localizedCard({
    zhCn: { summary: '工作空间导航', body: body('zh_cn') },
    enUs: { summary: 'Workspace navigation', body: body('en_us') },
  });
}
