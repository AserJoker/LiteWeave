/**
 * AppShell —— LiteWeave 整体布局骨架。
 *
 * 经典切分窗口：
 *   ┌────────────────────────────────────┐
 *   │ MenuBar                            │
 *   ├────────────────────────────────────┤
 *   │ Toolbar                            │
 *   ├──────┬──────────────┬──────────────┤
 *   │ Left │  Workspace   │ Right        │
 *   │ Side  │  Tabs        │ Sidebar      │
 *   │ bar  │              │ (Insp/AI)    │
 *   ├──────┴──────────────┴──────────────┤
 *   │ StatusBar                          │
 *   └────────────────────────────────────┘
 *
 * 左右侧边栏支持：点击切换按钮收起/展开、拖动分隔条调整宽度。
 * 布局容器类名见 App.css 的 lw-* 前缀。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { systemCommand } from '../../core/namespace';
import { MenuBar } from './MenuBar';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { WorkspaceTabs } from './WorkspaceTabs';
import { LeftSidebar } from '../Sidebar/LeftSidebar';
import { RightSidebar } from '../Sidebar/RightSidebar';
import { useCore } from '../../core/coreContext';
import type { AppCore } from '../../core/appCore';
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORE_KEY,
  normalizeLayout,
  type LayoutState,
  type PanelContainerState,
} from '../../core/layout/layoutTypes';
import { tabForResource } from '../../core/resources/resourceTypes';
import { RESOURCE_DELETED, RESOURCE_RENAMED, OPEN_RESOURCE_COMMAND } from '../../core/project/projectModule';
import {
  RUNNER_START_COMMAND,
  RUNNER_STOP_COMMAND,
  RUNNER_RELOAD_COMMAND,
  RUNNER_STATUS_CHANGED,
  type RunnerStatus,
} from '../../core/runner/runnerService';
import type { EditorTab } from '../types';

const LAYOUT_SET_COMMAND = systemCommand('layout:set');
const LAYOUT_LOADED_EVENT = systemCommand('layout:loaded');

const WELCOME_TAB: EditorTab = { id: 'welcome', title: '欢迎', icon: 'application', closable: false };

/** 资源打开命令载荷（与 ExplorerPanel 发出的契约一致） */
interface OpenResourceArgs {
  path?: string;
  name?: string;
  type?: 'file' | 'directory';
}

interface AppShellProps {
  /** 已打开的编辑器标签（欢迎页始终在首位） */
  tabs?: EditorTab[];
}

export function AppShell({ tabs: extraTabs = [] }: AppShellProps) {
  const core = useCore();
  // 已打开的编辑器标签（欢迎页固定，其余由外部传入/后续由打开操作产生）
  const [tabs, setTabs] = useState<EditorTab[]>([WELCOME_TAB, ...extraTabs]);
  const [activeTabId, setActiveTabId] = useState<string>(WELCOME_TAB.id);
  // activeTabId 的 ref 镜像：让事件订阅闭包能拿到最新活动 id（setState 异步，闭包拿到的 state 是初始值）
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  // 监听 system.resource:open：资源树点击文件 → 匹配资源类型 → 打开/激活对应编辑器标签（已开则激活）
  useEffect(() => {
    if (!core) return;
    const unsubOpen = core.commands.onCommand(OPEN_RESOURCE_COMMAND, (args) => {
      const { path, name } = (args ?? {}) as OpenResourceArgs;
      if (!path || !name) return;
      const type = core.resourceTypes.match({ name, path, type: 'file' });
      if (!type) {
        // 无匹配资源类型：暂不支持打开（占位），提示到状态栏
        console.warn(`[shell] 资源类型未匹配，暂不支持打开: ${path}`);
        return;
      }
      const tab = tabForResource(type, { name, path });
      setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
      setActiveTabId(tab.id);
    });

    // 资源文件已删除（删除成功后广播，含删除语言联动场景）→ 关闭对应编辑器标签并清理历史栈
    const unsubDeleted = core.events.subscribe(RESOURCE_DELETED, (payload) => {
      const { path } = (payload ?? {}) as { path?: string };
      if (!path) return;
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (next.length !== prev.length) {
          // 被删文件是当前活动标签：切到相邻标签
          setActiveTabId((cur) => (cur !== undefined && prev.find((t) => t.id === cur)?.path === path ? next[next.length - 1]?.id ?? WELCOME_TAB.id : cur));
          // 清空被删文件的历史栈（避免幽灵历史）
          core.history.clear(path);
        }
        return next;
      });
    });

    // 资源已重命名/移动 → 迁移编辑器标签 path/title/id + 历史栈路径
    const unsubRenamed = core.events.subscribe(RESOURCE_RENAMED, (payload) => {
      const { oldPath, newPath, isDir } = (payload ?? {}) as { oldPath?: string; newPath?: string; isDir?: boolean };
      if (!oldPath || !newPath || oldPath === newPath) return;
      setTabs((prev) => {
        let activeOldPath: string | undefined;
        const next = prev.map((tab) => {
          if (!tab.path) return tab;
          let newTabPath: string | undefined;
          if (isDir) {
            if (tab.path === oldPath) newTabPath = newPath;
            else if (tab.path.startsWith(oldPath + '/')) newTabPath = newPath + tab.path.slice(oldPath.length);
          } else {
            if (tab.path === oldPath) newTabPath = newPath;
          }
          if (!newTabPath) return tab;
          // 同步迁移历史栈（按文件粒度；目录场景每个 tab 单独迁移）
          core.history.renamePath(tab.path, newTabPath);
          const newName = newTabPath.split('/').pop() ?? tab.title;
          // 记录活动 tab 的旧 path，下面用它找新 id
          if (prev.find((t) => t.id === activeTabIdRef.current)?.path === tab.path) {
            activeOldPath = tab.path;
          }
          return { ...tab, id: `${tab.type}:${newTabPath}`, path: newTabPath, title: newName };
        });
        // 修复活动 tab id（id 因 path 变了，需要切到迁移后的新 id）
        if (activeOldPath) {
          const migrated = next.find((t) => t.path !== activeOldPath && t.type === prev.find((p) => p.path === activeOldPath)?.type);
          if (migrated) setActiveTabId(migrated.id);
        }
        return next;
      });
    });

    return () => {
      unsubOpen();
      unsubDeleted();
      unsubRenamed();
    };
  }, [core]);

  // 工作区布局（容器可见性 / 宽度 / 面板归属与激活），持久化到 layout 数据域
  const { layout, updateLayout } = usePersistentLayout(core ?? undefined);
  const left = layout.left;
  const right = layout.right;

  // 当前活动编辑器标签对应的文件路径（欢迎页/无编辑器为 undefined）
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activePath = activeTab?.path;

  // 活动编辑器路径 → 模块级状态（历史模块持有权威值并广播；UI 不直接 emit 业务事件）
  useEffect(() => {
    core?.history.setActivePath(activePath);
  }, [core, activePath]);

  // 撤销/重做可用性：当前活动文件是否有对应历史（订阅历史变更触发重渲染刷新）
  const [, setHistoryTick] = useState(0);
  useEffect(() => {
    if (!core || !activePath) return;
    return core.history.subscribe(() => setHistoryTick((t) => t + 1));
  }, [core, activePath]);
  const canUndo = !!activePath && !!core?.history.canUndo(activePath);
  const canRedo = !!activePath && !!core?.history.canRedo(activePath);

  // Runner 状态：订阅 system.runner:status-changed 刷新工具栏指示器
  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>('stopped');
  useEffect(() => {
    if (!core) return;
    // 拉取一次当前状态（冷启动时若 Runner 已在跑，IDE 重开要能恢复指示）
    void core.runner.getStatus().then((s) => setRunnerStatus(s.status)).catch(() => {});
    const unsub = core.events.subscribe(RUNNER_STATUS_CHANGED, (payload) => {
      const { status } = (payload ?? {}) as { status?: RunnerStatus };
      if (status) setRunnerStatus(status);
    });
    return unsub;
  }, [core]);

  // F5 快捷键：启动 / 重载 Runner（与工具栏"运行"按钮同链路；主进程已禁用 Chromium 默认 F5 刷新）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F5') return;
      e.preventDefault();
      if (!core) return;
      const active = runnerStatus === 'running' || runnerStatus === 'ready' || runnerStatus === 'starting';
      if (active) {
        void core.commands.runCommand(RUNNER_RELOAD_COMMAND);
      } else {
        void core.commands.runCommand(RUNNER_START_COMMAND, buildRunnerBootstrap(core.project.getCurrentProject()));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [core, runnerStatus]);

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next[next.length - 1]?.id ?? WELCOME_TAB.id);
      }
      return next;
    });
  };

  return (
    <div className="lw-shell bp6-dark">
      <MenuBar />
      <Toolbar
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => activePath && core?.history.undo(activePath)}
        onRedo={() => activePath && core?.history.redo(activePath)}
        leftSidebarVisible={left.visible}
        rightSidebarVisible={right.visible}
        onToggleLeftSidebar={() => updateLayout('left', { visible: !left.visible })}
        onToggleRightSidebar={() => updateLayout('right', { visible: !right.visible })}
        runnerStatus={runnerStatus}
        onRunnerStart={() => core && void core.commands.runCommand(RUNNER_START_COMMAND, buildRunnerBootstrap(core.project.getCurrentProject()))}
        onRunnerStop={() => core && void core.commands.runCommand(RUNNER_STOP_COMMAND)}
        onRunnerReload={() => core && void core.commands.runCommand(RUNNER_RELOAD_COMMAND)}
      />

      <div className="lw-main">
        {left.visible && (
          <>
            <aside className="lw-pane lw-pane-left" style={{ width: left.size }}>
              <LeftSidebar layout={left} onLayoutChange={(patch) => updateLayout('left', patch)} />
            </aside>
            <Splitter
              orientation="vertical"
              onDrag={(dx) => updateLayout('left', (prev) => ({ size: clamp(prev.size + dx, 180, 480) }))}
            />
          </>
        )}

        <main className="lw-workspace-pane">
          <WorkspaceTabs tabs={tabs} activeTabId={activeTabId} onTabChange={setActiveTabId} onTabClose={closeTab} />
        </main>

        {right.visible && (
          <>
            <Splitter
              orientation="vertical"
              onDrag={(dx) => updateLayout('right', (prev) => ({ size: clamp(prev.size - dx, 220, 520) }))}
            />
            <aside className="lw-pane lw-pane-right" style={{ width: right.size }}>
              <RightSidebar layout={right} onLayoutChange={(patch) => updateLayout('right', patch)} />
            </aside>
          </>
        )}
      </div>

      <StatusBar message="就绪" />
    </div>
  );
}

/** 布局容器变更：直接 patch 或基于最新容器状态计算的 patch（拖拽用后者，避免闭包旧值） */
type LayoutPatch = Partial<PanelContainerState> | ((prev: PanelContainerState) => Partial<PanelContainerState>);

/**
 * 布局持久化 hook：本地 state 主导 + 单向落盘写入 layout 数据域（防抖批量提交由 store 模块负责）。
 * - 挂载时 ensureLoaded 拉取持久化布局初始化（未加载过则用默认）
 * - updateLayout(container, patch)：合并到本地 state，并把整个布局写回 store（单向：不回读后端回推）
 * - 只订阅 system.layout:loaded 做初始化；不订阅 layout:changed（拖拽/开关高频变更，前端为权威，忽略回推避免覆盖）
 */
function usePersistentLayout(core: AppCore | undefined): {
  layout: LayoutState;
  updateLayout: (container: 'left' | 'right', patch: LayoutPatch) => void;
} {
  const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!core) return;
    // 拉取持久化布局（幂等：首次拉全量到 cache + 广播 loaded；已加载则直接 resolve）
    void core.layout
      .ensureLoaded()
      .then(() => {
        // 直接从 cache 读：AppShell 重挂载时（关闭→重新打开项目）layout 模块 loaded 标志仍为 true，
        // ensureLoaded 不会再次广播 LAYOUT_LOADED_EVENT；cache 是模块级持久存在，直接读即可。
        if (loadedRef.current) return;
        const raw = core.layout.get(LAYOUT_STORE_KEY);
        if (raw === undefined) return;
        loadedRef.current = true;
        setLayout(normalizeLayout(raw));
      })
      .catch((err) => {
        console.error('[layout] 加载布局失败，使用默认布局:', err);
      });

    // 兜底：首次冷启动 ensureLoaded 内部 load() 会广播 LAYOUT_LOADED_EVENT，
    // 上面 then 可能因时序错过事件（load 完成先于订阅），订阅兜底确保首次也能拿到。
    const unsubLoaded = core.events.subscribe(LAYOUT_LOADED_EVENT, (payload) => {
      if (loadedRef.current) return;
      const raw = (payload as { layout?: unknown } | undefined)?.layout;
      if (raw === undefined) return;
      loadedRef.current = true;
      setLayout(normalizeLayout(raw));
    });
    return () => {
      unsubLoaded();
    };
  }, [core]);

  const updateLayout = useCallback(
    (container: 'left' | 'right', patch: LayoutPatch) => {
      setLayout((prevLayout) => {
        const prevContainer = prevLayout[container];
        const resolved = typeof patch === 'function' ? patch(prevContainer) : patch;
        const next: LayoutState = {
          ...prevLayout,
          [container]: { ...prevContainer, ...resolved },
        };
        // 整体写回 layout 根 key（store 模块防抖批量提交 + 后端持久化；不回读后端回推）
        if (core) {
          void core.commands.runCommand(LAYOUT_SET_COMMAND, { key: LAYOUT_STORE_KEY, value: next });
        }
        return next;
      });
    },
    [core],
  );

  return { layout, updateLayout };
}

/** 拖动分隔条：返回水平（左右）拖动距离增量，供父级更新宽度。 */
function Splitter({ orientation, onDrag }: { orientation: 'vertical' | 'horizontal'; onDrag: (delta: number) => void }) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`lw-splitter lw-splitter-${orientation}${dragging ? ' lw-splitter-dragging' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        let lastX = startX;
        setDragging(true);
        const move = (ev: MouseEvent) => {
          onDrag(ev.clientX - lastX);
          lastX = ev.clientX;
        };
        const up = () => {
          setDragging(false);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * 从当前打开项目构造 Runner 启动 bootstrap。
 * IDE 持有 ProjectMeta（含 path 绝对路径 + entry 资源 id），主动传给主进程，
 * 主进程无需再 readMetaConfig 补全（MCP 调用只传 projectId 时主进程才补全）。
 */
function buildRunnerBootstrap(project: { id: string; name: string; path: string } | undefined): {
  projectId?: string;
  projectName?: string;
  projectRoot?: string;
} | undefined {
  if (!project) return undefined;
  return {
    projectId: project.id,
    projectName: project.name,
    projectRoot: project.path,
  };
}
