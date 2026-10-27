/**
 * 资源管理器面板 —— 左侧边栏的其中一个页面（标签容器里的内容）。
 *
 * 两种状态：
 * - 无项目：默认空态，提示到启动器打开项目（点按钮 → 回到启动器）
 * - 有项目：渲染真实资源树（目录可展开/折叠，文件点击发出 system.resource:open 命令）
 *
 * 能力（资源管理器主需求）：
 * - 右键菜单：新建资源…（向导，按资源类型填参数）/ 打开 / 删除（文件）
 * - 新建向导：从 ResourceType.create 声明读 schema，动态注入项目 namespaces/languages 选项，
 *   提交调 spec.buildArgs(values) → system.resource:create（与 MCP/AI 同一条命令链路）
 * - 选中态：文件点击/右键选中高亮；创建成功后自动展开父目录并选中新文件
 * - 删除确认：Alert → system.resource:delete（成功后 RESOURCE_DELETED 广播，编辑器关标签）
 * - 订阅 PROJECT_TREE_CHANGED：创建/删除/写文件后刷新树
 *
 * 数据源：core.project（createProjectModule），订阅 system.project:opened 刷新树。
 * 注意：本组件只负责内容，不负责容器外壳（标签头由 LeftSidebar 容器渲染）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  ContextMenu,
  Dialog,
  FormGroup,
  Icon,
  InputGroup,
  Intent,
  Menu,
  MenuDivider,
  MenuItem,
} from '@blueprintjs/core';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import { SchemaForm, type FormValues, type Schema, type SchemaNode, type SelectOption } from '../../core/schema/schemaForm';
import { createMemoryStore, type FormStore } from '../../core/schema/formStore';
import type { ResourceType } from '../../core/resources/resourceTypes';
import {
  OPEN_PROJECT_COMMAND,
  OPEN_RESOURCE_COMMAND,
  PROJECT_OPENED,
  PROJECT_OPEN_FAILED,
  PROJECT_CLOSED,
  PROJECT_TREE_CHANGED,
} from '../../core/project/projectModule';
import type { ProjectMeta, ProjectNode } from '../../core/project/projectModule';
import { ACTIVE_PATH_CHANGED } from '../../core/history/historyModule';

/** 目录名合法字符（字母开头，仅含字母/数字/下划线/连字符） */
const DIR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** 新建向导会话：资源类型 + 注入动态选项后的 schema + 内存 store（值不落 store，确定时提交） */
interface CreateSession {
  type: ResourceType;
  schema: Schema;
  store: FormStore;
}

/**
 * 克隆 schema 并按字段 key 注入动态 select 选项（不就地改共享的 ResourceType.create.schema，
 * 避免多次打开累积污染）。约定：schema 里 select 字段 options 为空数组时按 key 从项目配置补：
 * - key === 'namespace' → 项目 namespaces（value=ns，labelKey=ns 原样显示）
 * - key === 'lang' → 项目 languages（value=id，labelKey="id display_name"）
 */
function cloneAndInjectOptions(
  schema: Schema,
  resolveOptions: (key: string) => SelectOption[] | undefined,
): Schema {
  return schema.map((node) => {
    if (node.kind === 'field' && node.field.type === 'select') {
      const opts = resolveOptions(node.field.key);
      return opts ? { ...node, field: { ...node.field, options: opts } } : node;
    }
    if (node.kind === 'group') {
      return { ...node, children: cloneAndInjectOptions(node.children, resolveOptions) };
    }
    return node;
  });
}

/** 构建新建向导会话：注入动态选项 + 默认值（namespace 默认项目 defaultNamespace） */
function buildCreateSession(type: ResourceType, config: ProjectMeta | undefined): CreateSession {
  const spec = type.create!;
  const namespaces = config?.namespaces ?? [];
  const languages = config?.languages ?? [];
  const defaultNs = config?.defaultNamespace ?? '';

  const schema = cloneAndInjectOptions(spec.schema, (key) => {
    if (key === 'namespace') return namespaces.map((ns) => ({ value: ns, labelKey: ns }));
    if (key === 'lang') return languages.map((l) => ({ value: l.id, labelKey: `${l.id} ${l.display_name}` }));
    return undefined;
  });

  const initial: FormValues = {};
  if (defaultNs) initial['namespace'] = defaultNs;

  return { type, schema, store: createMemoryStore(initial) };
}

/** 从 store 收集 schema 全部字段值（供 validate / buildArgs 消费） */
function collectValues(schema: Schema, store: FormStore): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const visit = (nodes: SchemaNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'field') {
        const v = store.get(node.field.key);
        if (v !== undefined) values[node.field.key] = v;
      } else if (node.kind === 'group') {
        visit(node.children);
      } else {
        const v = store.get(node.key);
        if (v !== undefined) values[node.key] = v;
      }
    }
  };
  visit(schema);
  return values;
}

/** 从右键鼠标事件位置反查命中的树行路径（行 DOM 带 data-path；空白处返回 undefined） */
function targetPathFromEvent(e: React.MouseEvent): string | undefined {
  const el = e.target instanceof Element ? e.target.closest('[data-path]') : undefined;
  return el?.getAttribute('data-path') ?? undefined;
}

/** 按路径在树中查找节点（扁平递归搜索） */
function findNodeByPath(nodes: ProjectNode[] | undefined, path: string | undefined): ProjectNode | undefined {
  if (!path || !nodes) return undefined;
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.type === 'directory' && node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function TreeItem({
  node,
  depth,
  expandedIds,
  onToggle,
  selectedPath,
  onSelect,
  dragOverPath,
  onDragStart,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
}: {
  node: ProjectNode;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  selectedPath: string | undefined;
  onSelect: (node: ProjectNode) => void;
  /** 当前 dragover 高亮的路径（目录高亮 / 空白处根高亮） */
  dragOverPath: string | undefined;
  /** dragstart：把源 path 写入 dataTransfer + 模块级 ref */
  onDragStart: (e: React.DragEvent, node: ProjectNode) => void;
  /** dragover 行：目录行作为 drop target，preventDefault 启用 drop + 标记高亮 */
  onDragOverRow: (e: React.DragEvent, node: ProjectNode) => void;
  /** dragleave 行：清高亮（仅当离开的是当前高亮 path） */
  onDragLeaveRow: (e: React.DragEvent, node: ProjectNode) => void;
  /** drop 行：调 rename(oldPath, `${node.path}/${name}`) */
  onDropRow: (e: React.DragEvent, node: ProjectNode) => void;
}) {
  const core = useCore();
  const isDir = node.type === 'directory';
  const hasChildren = isDir && !!node.children && node.children.length > 0;
  const expanded = expandedIds.has(node.path);
  const selected = selectedPath === node.path;
  const dragOver = dragOverPath === node.path;

  const handleClick = () => {
    if (isDir) {
      // 目录：选中（高亮）+ 展开/折叠。选中不影响编辑器（不发 resource:open）。
      onSelect(node);
      if (hasChildren) onToggle(node.path);
    } else if (core) {
      // 文件：选中 + 发命令打开（AppShell 订阅匹配资源类型 → 编辑器标签）
      onSelect(node);
      void core.commands.runCommand(OPEN_RESOURCE_COMMAND, {
        path: node.path,
        name: node.name,
      });
    }
  };

  return (
    <div className="lw-tree-item">
      <div
        className={`lw-tree-row${selected ? ' lw-tree-row-selected' : ''}${dragOver ? ' lw-tree-row-drag-over' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={handleClick}
        onDragStart={(e) => onDragStart(e, node)}
        onDragOver={(e) => onDragOverRow(e, node)}
        onDragLeave={(e) => onDragLeaveRow(e, node)}
        onDrop={(e) => onDropRow(e, node)}
        draggable
        data-path={node.path}
        title={node.path}
      >
        <span className="lw-tree-caret">
          {isDir ? (
            hasChildren ? (
              <Icon icon={expanded ? 'chevron-down' : 'chevron-right'} size={10} />
            ) : (
              <span className="lw-tree-caret-spacer" />
            )
          ) : (
            <span className="lw-tree-caret-spacer" />
          )}
        </span>
        <Icon
          icon={(isDir ? (expanded ? 'folder-open' : 'folder-close') : 'document') as never}
          size={14}
        />
        <span className="lw-tree-label">{node.name}</span>
      </div>
      {hasChildren && expanded && (
        <div className="lw-tree-children">
          {node.children!.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
              dragOverPath={dragOverPath}
              onDragStart={onDragStart}
              onDragOverRow={onDragOverRow}
              onDragLeaveRow={onDragLeaveRow}
              onDropRow={onDropRow}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ExplorerPanel() {
  const core = useCore();
  const { t } = useI18n();

  // 初始：从 core.project 惰性取当前项目状态（若已有项目，如刷新后）
  const [tree, setTree] = useState<ProjectNode[] | undefined>(() => core?.project.getTree());
  const [projectName, setProjectName] = useState<string | undefined>(() => core?.project.getCurrentProject()?.name);
  const [webFallback, setWebFallback] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set((core?.project.getTree() ?? []).map((n) => (n.type === 'directory' ? n.path : '')).filter(Boolean)),
  );
  /** 选中路径（文件点击/右键选中高亮；创建成功后自动选中新文件） */
  const [selectedPath, setSelectedPath] = useState<string | undefined>();

  // 新建向导（资源）
  const [createOpen, setCreateOpen] = useState(false);
  const [createSession, setCreateSession] = useState<CreateSession | undefined>();
  const [createError, setCreateError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  // 新建目录向导（自由创建，简单输入框）
  const [createDirOpen, setCreateDirOpen] = useState(false);
  /** 目录向导会话：父路径（建在其下）+ 用户输入的目录名 */
  const [createDirSession, setCreateDirSession] = useState<{
    parentPath: string;       // 新目录的父路径（空白处=项目根 → ''；目录行=该目录 path）
    name: string;             // 用户输入的目录名
  } | undefined>();
  const [createDirError, setCreateDirError] = useState<string | undefined>();
  const [creatingDir, setCreatingDir] = useState(false);

  // 删除确认（文件）
  const [deleteTarget, setDeleteTarget] = useState<ProjectNode | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  // 删除确认（目录，递归）
  const [deleteDirTarget, setDeleteDirTarget] = useState<ProjectNode | undefined>();
  const [deletingDir, setDeletingDir] = useState(false);
  const [deleteDirError, setDeleteDirError] = useState<string | undefined>();

  // 重命名向导（文件/目录共用；输入新名，校验合法字符 + 目标不存在）
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectNode | undefined>();
  /** 重命名会话：源节点类型 + 旧 path + 父目录 + 用户输入的新名 */
  const [renameSession, setRenameSession] = useState<{
    isDir: boolean;
    oldPath: string;
    parentPath: string; // 旧 path 的父目录（newPath = parentPath ? `${parentPath}/${name}` : name）
    name: string;
  } | undefined>();
  const [renameError, setRenameError] = useState<string | undefined>();
  const [renaming, setRenaming] = useState(false);

  // 拖拽（原生 HTML5 DnD）：源 path ref + 当前 dragover 高亮 path
  // dataTransfer 在 dragenter/dragover 期间受保护模式读不到，源 path 用模块级 ref 持有
  const dragSourcePathRef = useRef<string | undefined>(undefined);
  const [dragOverPath, setDragOverPath] = useState<string | undefined>(undefined);

  /** 校验源 → 目标目录的移动是否合法（防止拖到自己/子孙目录） */
  const canDropTo = (sourcePath: string | undefined, targetDir: string): boolean => {
    if (!sourcePath || sourcePath === targetDir) return false;
    // 目标必须是源的兄弟或祖先之外；源不能是目标目录的祖先（即 target 不能以 source/ 开头）
    if (targetDir === sourcePath) return false;
    if (targetDir.startsWith(sourcePath + '/')) return false;
    // 同父目录拖动 = 无意义（newPath 等于 oldPath）
    const sourceParent = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    if (targetDir === sourceParent) return false;
    return true;
  };

  /** 移动源到目标目录：newPath = targetDir ? `${targetDir}/${name}` : name */
  const moveNodeTo = async (sourcePath: string, targetDir: string): Promise<void> => {
    if (!core) return;
    const name = sourcePath.includes('/') ? sourcePath.slice(sourcePath.lastIndexOf('/') + 1) : sourcePath;
    const newPath = targetDir ? `${targetDir}/${name}` : name;
    if (newPath === sourcePath) return;
    try {
      const r = await core.project.rename(sourcePath, newPath);
      if (r.ok) {
        setSelectedPath(newPath);
        // 展开目标目录（让用户看到拖进去的结果）
        if (targetDir) {
          setExpandedIds((prev) => {
            const next = new Set(prev);
            next.add(targetDir);
            return next;
          });
        }
      } else {
        console.warn('[explorer] 拖拽移动失败:', r.error);
      }
    } catch (err) {
      console.error('[explorer] 拖拽移动异常:', err);
    }
  };

  const handleDragStart = (e: React.DragEvent, node: ProjectNode) => {
    dragSourcePathRef.current = node.path;
    e.dataTransfer.effectAllowed = 'move';
    // 私有 mime + 兜底 text/plain（部分浏览器 dragover 期间只能读 text/plain）
    try {
      e.dataTransfer.setData('application/x-liteweave-path', node.path);
    } catch {
      // 忽略：异常 mime 偶尔被某些浏览器拒绝
    }
    e.dataTransfer.setData('text/plain', node.path);
  };

  const handleDragOverRow = (e: React.DragEvent, node: ProjectNode) => {
    // 仅目录作为 drop target（文件不接收）
    if (node.type !== 'directory') return;
    const source = dragSourcePathRef.current;
    if (!canDropTo(source, node.path)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverPath !== node.path) setDragOverPath(node.path);
  };

  const handleDragLeaveRow = (_e: React.DragEvent, node: ProjectNode) => {
    // 仅清自己对应的高亮（防止子行 dragover 重新触发被父行 leave 清掉）
    if (dragOverPath === node.path) setDragOverPath(undefined);
  };

  const handleDropRow = (e: React.DragEvent, node: ProjectNode) => {
    if (node.type !== 'directory') return;
    const source = dragSourcePathRef.current;
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(undefined);
    dragSourcePathRef.current = undefined;
    if (!canDropTo(source, node.path)) return;
    void moveNodeTo(source!, node.path);
  };

  /** 根容器 dragover：空白处 = 项目根（targetDir=''） */
  const handleDragOverRoot = (e: React.DragEvent) => {
    const source = dragSourcePathRef.current;
    if (!source) return;
    // 仅当直接 hover 在根容器本身（非冒泡自子行）才标记根为 drop target
    const isOnRoot = e.target === e.currentTarget;
    if (!isOnRoot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverPath !== '') setDragOverPath('');
  };

  const handleDropRoot = (e: React.DragEvent) => {
    const source = dragSourcePathRef.current;
    const isOnRoot = e.target === e.currentTarget;
    if (!isOnRoot) return;
    e.preventDefault();
    setDragOverPath(undefined);
    dragSourcePathRef.current = undefined;
    if (!source) return;
    // 拖到根：源不能本身就在根（source 不含 /）
    if (!source.includes('/')) return;
    void moveNodeTo(source, '');
  };

  /** 拖拽结束（无论是否 drop 成功）：清理状态 */
  const handleDragEnd = () => {
    dragSourcePathRef.current = undefined;
    setDragOverPath(undefined);
  };

  /** 可创建的资源类型（ResourceType.create 声明存在才出现在向导里） */
  const createTypes = useMemo(
    () => (core?.resourceTypes.list() ?? []).filter((rt) => rt.create),
    [core],
  );

  // 订阅项目事件：打开成功刷新树，关闭清空，失败/取消处理；树变更（创建/删除/写文件）刷新
  useEffect(() => {
    if (!core) return;
    const unsubProject = core.project.subscribe((event, payload) => {
      if (event === PROJECT_OPENED) {
        const { project, tree: t } = payload as { project?: { name?: string }; tree?: ProjectNode[] };
        if (project && t) {
          setProjectName(project.name);
          setTree(t);
          setWebFallback(false);
          setExpandedIds(new Set(t.map((n) => (n.type === 'directory' ? n.path : '')).filter(Boolean)));
          setSelectedPath(undefined);
        }
      } else if (event === PROJECT_CLOSED) {
        setTree(undefined);
        setProjectName(undefined);
        setSelectedPath(undefined);
      } else if (event === PROJECT_OPEN_FAILED) {
        const { error } = payload as { error?: string };
        if (error === 'not-in-electron') setWebFallback(true);
      } else if (event === PROJECT_TREE_CHANGED) {
        const { tree: newTree } = payload as { tree?: ProjectNode[] };
        if (newTree) setTree(newTree);
      }
    });

    // 反向同步：编辑器标签激活（history.setActivePath 广播）→ 资源管理器选中 + 父目录逐级展开
    const unsubActive = core.events.subscribe(ACTIVE_PATH_CHANGED, (payload) => {
      const { path } = (payload ?? {}) as { path?: string };
      if (!path) return;
      setSelectedPath(path);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          next.add(parts.slice(0, i).join('/'));
        }
        return next;
      });
    });

    return () => {
      unsubProject();
      unsubActive();
    };
  }, [core]);

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpenProject = () => {
    if (core) void core.commands.runCommand(OPEN_PROJECT_COMMAND);
  };

  /** 打开文件（右键“打开”/ 点击共用路径） */
  const handleOpenNode = (node: ProjectNode) => {
    if (!core) return;
    setSelectedPath(node.path);
    void core.commands.runCommand(OPEN_RESOURCE_COMMAND, { path: node.path, name: node.name });
  };

  /** 打开新建向导：无可用类型时提示 emptyTypes；默认选中第一个类型（config 未加载则先拉取） */
  const openCreateDialog = (type: ResourceType) => {
    setCreateError(undefined);
    setCreateOpen(true);
    // 向导选项（namespaces/languages）来自 project.json：打开前确保 config 已加载（项目打开后 cache 为空）
    void (async () => {
      let config = core?.project.getConfig();
      if (!config) config = await core?.project.loadConfig();
      setCreateSession(buildCreateSession(type, config));
    })();
  };

  /** 向导内切换资源类型：重建会话（重新注入动态选项） */
  /** 提交创建：validate → buildArgs → system.resource:create（与 MCP/AI 同链路） */
  const handleCreate = async () => {
    if (!core || !createSession || creating) return;
    const spec = createSession.type.create!;
    const values = collectValues(createSession.schema, createSession.store);
    if (spec.validate) {
      const msg = spec.validate(values);
      if (msg) {
        setCreateError(t(msg));
        return;
      }
    }
    const args = spec.buildArgs(values);
    setCreating(true);
    setCreateError(undefined);
    try {
      const r = await core.project.createFile(args);
      if (r.ok) {
        // 创建成功：展开父目录并选中新文件，再发 resource:open 打开编辑器标签（与点击文件同链路）
        const createdPath = args.path;
        if (createdPath) {
          const name = createdPath.split('/').pop() ?? '';
          setSelectedPath(createdPath);
          setExpandedIds((prev) => {
            const next = new Set(prev);
            const parts = createdPath.split('/');
            for (let i = 1; i < parts.length; i++) {
              next.add(parts.slice(0, i).join('/'));
            }
            return next;
          });
          void core.commands.runCommand(OPEN_RESOURCE_COMMAND, { path: createdPath, name });
        }
        setCreateOpen(false);
        setCreateSession(undefined);
      } else {
        setCreateError(r.error ?? t('system.resource.create.error'));
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  /** 删除文件：确认后 system.resource:delete（成功后 RESOURCE_DELETED 广播 → 编辑器关标签） */
  const handleDelete = async () => {
    if (!core || !deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const r = await core.project.deleteFile(deleteTarget.path);
      if (r.ok) {
        setSelectedPath((prev) => (prev === deleteTarget.path ? undefined : prev));
        setDeleteTarget(undefined);
      } else {
        setDeleteError(r.error ?? t('system.resource.create.error'));
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreateSession(undefined);
    setCreateError(undefined);
  };

  /**
   * 打开新建目录向导：按右键位置确定父路径。
   * - 空白处右键 → parentPath=''（项目根下）
   * - 右键目录 → parentPath=node.path
   * - 右键文件 → 用其父目录作 parentPath
   * 自由创建，不限层级。
   */
  const openCreateDirDialog = (parentPath: string) => {
    setCreateDirError(undefined);
    setCreateDirOpen(true);
    setCreateDirSession({ parentPath, name: '' });
  };

  /** 提交创建目录：校验目录名 → 组装 path → system.dir:create */
  const handleCreateDir = async () => {
    if (!core || !createDirSession || creatingDir) return;
    const name = createDirSession.name.trim();
    if (!name || !DIR_NAME_RE.test(name)) {
      setCreateDirError(t('system.resource.dir.invalidName'));
      return;
    }
    const fullPath = createDirSession.parentPath ? `${createDirSession.parentPath}/${name}` : name;
    setCreatingDir(true);
    setCreateDirError(undefined);
    try {
      const r = await core.project.createDir({ path: fullPath });
      if (r.ok) {
        // 展开父目录 + 选中新目录
        setSelectedPath(fullPath);
        setExpandedIds((prev) => {
          const next = new Set(prev);
          if (createDirSession.parentPath) next.add(createDirSession.parentPath);
          return next;
        });
        setCreateDirOpen(false);
        setCreateDirSession(undefined);
      } else {
        setCreateDirError(r.error ?? t('system.resource.dir.error'));
      }
    } catch (err) {
      setCreateDirError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDir(false);
    }
  };

  const closeCreateDirDialog = () => {
    setCreateDirOpen(false);
    setCreateDirSession(undefined);
    setCreateDirError(undefined);
  };

  /**
   * 打开重命名向导：按右键节点确定旧 path + 父目录 + 初始名（旧名预填）。
   * 文件/目录共用；newPath = parentPath ? `${parentPath}/${newName}` : newName。
   */
  const openRenameDialog = (node: ProjectNode) => {
    setRenameError(undefined);
    setRenameTarget(node);
    const parts = node.path.split('/');
    parts.pop();
    const parentPath = parts.join('/');
    setRenameOpen(true);
    setRenameSession({
      isDir: node.type === 'directory',
      oldPath: node.path,
      parentPath,
      name: node.name,
    });
  };

  /** 提交重命名：校验新名 → 组装 newPath → system.resource:rename（与 MCP/AI 同链路） */
  const handleRename = async () => {
    if (!core || !renameSession || renaming) return;
    const name = renameSession.name.trim();
    // 校验：与新建目录同款字符集（字母开头，仅含字母/数字/下划线/连字符）；
    // 文件名可含一个点（扩展名），但首字符仍须字母
    const fileRe = /^[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+$/;
    const dirRe = DIR_NAME_RE;
    const re = renameSession.isDir ? dirRe : fileRe;
    if (!name || !re.test(name)) {
      setRenameError(t('system.resource.rename.invalidName'));
      return;
    }
    const newPath = renameSession.parentPath ? `${renameSession.parentPath}/${name}` : name;
    if (newPath === renameSession.oldPath) {
      setRenameOpen(false);
      setRenameSession(undefined);
      return;
    }
    setRenaming(true);
    setRenameError(undefined);
    try {
      const r = await core.project.rename(renameSession.oldPath, newPath);
      if (r.ok) {
        // 选中重命名后的新节点（树刷新后路径变了，用 newPath 高亮）
        setSelectedPath(newPath);
        setRenameOpen(false);
        setRenameSession(undefined);
        setRenameTarget(undefined);
      } else {
        setRenameError(r.error ?? t('system.resource.rename.error'));
      }
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenaming(false);
    }
  };

  const closeRenameDialog = () => {
    setRenameOpen(false);
    setRenameSession(undefined);
    setRenameError(undefined);
    setRenameTarget(undefined);
  };

  /** 删除目录：递归删除（Alert 确认后调用） */
  const handleDeleteDir = async () => {
    if (!core || !deleteDirTarget || deletingDir) return;
    setDeletingDir(true);
    setDeleteDirError(undefined);
    try {
      const r = await core.project.deleteDir(deleteDirTarget.path);
      if (r.ok) {
        setSelectedPath((prev) => (prev === deleteDirTarget.path ? undefined : prev));
        setDeleteDirTarget(undefined);
      } else {
        setDeleteDirError(r.error ?? t('system.resource.dir.error'));
      }
    } catch (err) {
      setDeleteDirError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingDir(false);
    }
  };

  return (
    <ContextMenu
      disabled={createOpen || createDirOpen || !!deleteTarget || !!deleteDirTarget || renameOpen}
      content={({ mouseEvent }) => {
        // 从右键事件位置反查命中节点（纯计算，不 setState）
        // 空白处：node=undefined，parentPath=''
        // 目录行：node=该目录，parentPath=node.path
        // 文件行：node=该文件，parentPath=父目录
        // 注意：Blueprint ContextMenu 首次调用 content 时 mouseEvent 可能为 undefined，
        // 此时返回空 Menu（不渲染任何项），等 mouseEvent 就绪后再渲染正确菜单——
        // 避免文件行右键时"新建目录/新建资源"选项短暂闪现（1-2 帧）
        if (!mouseEvent) return <Menu />;
        const node = findNodeByPath(tree, targetPathFromEvent(mouseEvent));
        let parentPath = '';
        if (node?.type === 'directory') {
          parentPath = node.path;
        } else if (node?.type === 'file') {
          const parts = node.path.split('/');
          parts.pop();
          parentPath = parts.join('/');
        }
        const isDir = node?.type === 'directory';
        const isFile = node?.type === 'file';
        return (
          <Menu>
            {/* 新建目录…/新建资源… 只在空白处或目录行显示（文件行不提供创建子项） */}
            {!isFile && (
              <>
                <MenuItem
                  icon="folder-new"
                  text={t('system.resource.context.newDir')}
                  onClick={() => openCreateDirDialog(parentPath)}
                />
                {/* 新建资源… 子菜单：每种资源类型一项，点击直接打开对应向导 */}
                <MenuItem icon="new-object" text={t('system.resource.context.new')} disabled={createTypes.length === 0}>
                  {createTypes.map((ct) => (
                    <MenuItem
                      key={ct.type}
                      icon={ct.icon as import('@blueprintjs/icons').IconName}
                      text={t(ct.titleKey)}
                      onClick={() => openCreateDialog(ct)}
                    />
                  ))}
                </MenuItem>
              </>
            )}
            {isFile && (
              <>
                <MenuItem icon="document-open" text={t('system.resource.context.open')} onClick={() => handleOpenNode(node!)} />
              </>
            )}
            {(isDir || isFile) && (
              <>
                <MenuDivider />
                <MenuItem
                  icon="edit"
                  text={t('system.resource.context.rename')}
                  onClick={() => openRenameDialog(node!)}
                />
                <MenuItem
                  icon="trash"
                  text={t('system.resource.context.delete')}
                  intent={Intent.DANGER}
                  onClick={() => {
                    if (isFile) {
                      setDeleteError(undefined);
                      setDeleteTarget(node!);
                    } else {
                      setDeleteDirError(undefined);
                      setDeleteDirTarget(node!);
                    }
                  }}
                />
              </>
            )}
          </Menu>
        );
      }}
      popoverProps={{ transitionDuration: 0 }}
      onContextMenu={(e) => {
        // 事件处理器：右键文件/目录时同步选中
        const node = findNodeByPath(tree, targetPathFromEvent(e));
        if (node) setSelectedPath(node.path);
      }}
    >
      {({ className, onContextMenu, popover, ref }) => (
        <div
          className={`${className} lw-explorer${dragOverPath === '' ? ' lw-explorer-drag-over' : ''}`}
          onContextMenu={onContextMenu}
          onDragOver={handleDragOverRoot}
          onDrop={handleDropRoot}
          onDragEnd={handleDragEnd}
          ref={ref}
        >
          {popover}
          {!tree ? (
            /* 空态：无项目，提示到启动器打开项目 */
            <div className="lw-explorer-empty">
              <Button
                icon="folder-open"
                text={webFallback ? '请在桌面端打开项目' : '打开项目'}
                onClick={handleOpenProject}
                className="lw-open-project-btn"
              />
              {webFallback && <div className="lw-explorer-hint">当前是浏览器模式，无法访问磁盘目录</div>}
            </div>
          ) : (
            <>
              {projectName && <div className="lw-explorer-path" title={projectName}>{projectName}</div>}
              {tree.map((node) => (
                <TreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedIds={expandedIds}
                  onToggle={toggle}
                  selectedPath={selectedPath}
                  onSelect={(n) => setSelectedPath(n.path)}
                  dragOverPath={dragOverPath}
                  onDragStart={handleDragStart}
                  onDragOverRow={handleDragOverRow}
                  onDragLeaveRow={handleDragLeaveRow}
                  onDropRow={handleDropRow}
                />
              ))}
            </>
          )}

          {/* 新建资源向导 */}
          <Dialog
        isOpen={createOpen}
        onClose={closeCreateDialog}
        title={createSession ? t(createSession.type.titleKey) : t('system.resource.create.title')}
        icon="new-object"
        canOutsideClickClose={false}
        className="bp6-dark lw-resource-create-dialog"
      >
        <div className="lw-resource-create-body">
          {createSession && (
            <SchemaForm
              schema={createSession.schema}
              store={createSession.store}
              t={t}
              renderers={core?.schemaRenderers}
            />
          )}
          {createError && <div className="lw-resource-create-error">{createError}</div>}
        </div>
        <div className="bp6-dialog-footer-actions lw-resource-create-footer">
          <Button text={t('system.resource.create.cancel')} onClick={closeCreateDialog} />
          <Button
            text={t('system.resource.create.create')}
            intent={Intent.PRIMARY}
            loading={creating}
            disabled={!createSession}
            onClick={() => void handleCreate()}
          />
        </div>
      </Dialog>

      {/* 删除确认（文件） */}
      <Alert
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(undefined)}
        onConfirm={() => void handleDelete()}
        confirmButtonText={t('system.resource.delete.ok')}
        cancelButtonText={t('system.resource.delete.cancel')}
        intent={Intent.DANGER}
        loading={deleting}
        canOutsideClickCancel
        className="bp6-dark"
      >
        <p>{t('system.resource.delete.body').replaceAll('{name}', deleteTarget?.name ?? '')}</p>
        {deleteError && <div className="lw-resource-create-error">{deleteError}</div>}
      </Alert>

      {/* 新建目录向导（自由创建，单一输入框） */}
      <Dialog
        isOpen={createDirOpen}
        onClose={closeCreateDirDialog}
        title={t('system.resource.dir.title')}
        icon="folder-new"
        canOutsideClickClose={false}
        className="bp6-dark lw-resource-create-dialog"
      >
        <div className="lw-resource-create-body">
          <FormGroup
            label={t('system.resource.dir.folderName')}
            helperText={t('system.resource.dir.folderNameHelper')}
          >
            <InputGroup
              placeholder={t('system.resource.dir.folderNamePlaceholder')}
              value={createDirSession?.name ?? ''}
              onChange={(e) => setCreateDirSession((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              autoFocus
            />
          </FormGroup>
          {createDirError && <div className="lw-resource-create-error">{createDirError}</div>}
        </div>
        <div className="bp6-dialog-footer-actions lw-resource-create-footer">
          <Button text={t('system.resource.dir.cancel')} onClick={closeCreateDirDialog} />
          <Button
            text={t('system.resource.dir.create')}
            intent={Intent.PRIMARY}
            loading={creatingDir}
            disabled={!createDirSession?.name.trim()}
            onClick={() => void handleCreateDir()}
          />
        </div>
      </Dialog>

      {/* 删除确认（目录，递归） */}
      <Alert
        isOpen={!!deleteDirTarget}
        onClose={() => setDeleteDirTarget(undefined)}
        onConfirm={() => void handleDeleteDir()}
        confirmButtonText={t('system.resource.deleteDir.ok')}
        cancelButtonText={t('system.resource.deleteDir.cancel')}
        intent={Intent.DANGER}
        loading={deletingDir}
        canOutsideClickCancel
        className="bp6-dark"
      >
        <p>{t('system.resource.deleteDir.body').replaceAll('{name}', deleteDirTarget?.name ?? '')}</p>
        {deleteDirError && <div className="lw-resource-create-error">{deleteDirError}</div>}
      </Alert>

      {/* 重命名向导（文件/目录共用；旧名预填，校验合法字符 + 目标不存在） */}
      <Dialog
        isOpen={renameOpen}
        onClose={closeRenameDialog}
        title={t('system.resource.rename.title')}
        icon="edit"
        canOutsideClickClose={false}
        className="bp6-dark lw-resource-create-dialog"
      >
        <div className="lw-resource-create-body">
          <FormGroup
            label={renameSession?.isDir
              ? t('system.resource.rename.dirLabel')
              : t('system.resource.rename.fileLabel')}
            helperText={renameSession?.isDir
              ? t('system.resource.rename.dirHelper')
              : t('system.resource.rename.fileHelper')}
          >
            <InputGroup
              placeholder={t('system.resource.rename.placeholder')}
              value={renameSession?.name ?? ''}
              onChange={(e) => setRenameSession((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              autoFocus
            />
          </FormGroup>
          {renameError && <div className="lw-resource-create-error">{renameError}</div>}
        </div>
        <div className="bp6-dialog-footer-actions lw-resource-create-footer">
          <Button text={t('system.resource.rename.cancel')} onClick={closeRenameDialog} />
          <Button
            text={t('system.resource.rename.ok')}
            intent={Intent.PRIMARY}
            loading={renaming}
            disabled={!renameSession?.name.trim() || renameSession?.name.trim() === renameTarget?.name}
            onClick={() => void handleRename()}
          />
        </div>
      </Dialog>
        </div>
      )}
    </ContextMenu>
  );
}
