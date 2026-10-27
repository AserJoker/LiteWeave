/**
 * LiteWeave 编辑器根组件。
 *
 * 启动装配：
 * - createAppCore()：创建 core（事件总线 + 命令总线 + 模块注册表），注册 settings 模块，
 *   并把后端全量设置加载到前端 cache
 * - 连接 SSE：订阅后端设置变更推送（settings 模块 applyRemoteChange → 广播 system.settings:changed）
 * - 用 CoreProvider 把 core 注入组件树，供设置对话框等组件使用
 * - 界面切换：未打开项目 → ProjectLauncher（启动器）；打开项目 → AppShell（编辑器）
 *
 * 整体布局骨架（经典切分窗口）由 `AppShell` 承载：
 *   MenuBar / Toolbar / 左右抽屉侧边栏 / 中间多标签编辑区 / StatusBar。
 */
import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/shell/AppShell';
import { ProjectLauncher } from './components/launcher/ProjectLauncher';
import { CoreProvider } from './core/CoreProvider';
import { I18nProvider } from './core/i18n/i18nContext';
import { createAppCore, type AppCore } from './core/appCore';
import { connectStoreSSE } from './core/store/sseClient';
import { PROJECT_CLOSED, PROJECT_OPENED } from './core/project/projectModule';
import './App.css';

function App() {
  const [core, setCore] = useState<AppCore | null>(null);
  const [hasProject, setHasProject] = useState(false);
  // 刷新恢复守卫：同一挂载周期内只执行一次 URL → 项目恢复（StrictMode 双挂载防重复打开）
  const restoredRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribeProject: (() => void) | undefined;

    // 暗色主题全局挂载（App 常驻，启动器与编辑器都生效；Portal 浮层另加 bp6-dark）
    document.documentElement.setAttribute('data-bp-color-scheme', 'dark');

    const disconnects: Array<() => void> = [];

    void createAppCore()
      .then((c) => {
        if (disposed) return;
        setCore(c);
        // 连推送：后端 settings 域变更 → 更新 cache + 广播事件（底层 transport：Electron=IPC / Web=SSE）
        // 注意：layout 域不走 SSE 订阅——拖拽是高频变更，SSE 回推会触发 applyRemoteChange →
        // 广播 changed → 订阅者重渲染，与本地 state 主导的拖拽流程叠加造成卡顿。
        // layout 改用"初始化主动拉取 + 运行时只写不读"模式（见 usePersistentLayout）。
        disconnects.push(connectStoreSSE('settings', c.settings, c.transport));
        // 项目开关 → 切换 启动器 / 编辑器
        setHasProject(!!c.project.getCurrentProject());
        unsubscribeProject = c.project.subscribe((event) => {
          if (event === PROJECT_OPENED) {
            setHasProject(true);
            // URL 记录当前页面：主页面（携带项目 id，刷新后据此恢复）
            const id = c.project.getCurrentProject()?.id;
            syncUrl(id ? 'project' : 'bootstrap', id);
            // 进入编辑器自动最大化窗口（Electron 原生能力；Web 模式无此 channel，忽略失败）
            void c.transport.invoke('window:maximize').catch(() => {});
          } else if (event === PROJECT_CLOSED) {
            setHasProject(false);
            // 回到启动器：URL 记录 bootstrap 页面
            syncUrl('bootstrap');
            // 回到启动器恢复窗口大小（与进入编辑器最大化对称；Web 模式忽略失败）
            void c.transport.invoke('window:restore').catch(() => {});
          }
        });

        // 刷新恢复：URL 记录的是主页面 + 项目 id，且模块级当前项目已丢失 → 重新打开该项目
        const route = parseUrl();
        if (!disposed && route.kind === 'project' && route.id && !c.project.getCurrentProject() && !restoredRef.current) {
          restoredRef.current = true;
          void c.project.open(route.id).catch((err) => {
            console.error('[app] 刷新恢复项目失败:', err);
            syncUrl('bootstrap');
          });
        }
      })
      .catch((err) => {
        console.error('[app] core 初始化失败:', err);
      });

    return () => {
      disposed = true;
      disconnects.forEach((fn) => fn());
      unsubscribeProject?.();
    };
  }, []);

  // 启动即加载持久化设置：语言等全局配置在启动器界面就生效（不必等进入编辑器/打开设置）。
  // 放独立 effect（依赖 core）：I18nProvider 订阅已注册后才拉取，settings:loaded → 语言联动不丢事件。
  useEffect(() => {
    if (!core) return;
    void core.settings.ensureLoaded();
  }, [core]);

  return (
    <CoreProvider core={core}>
      {core && (
        <I18nProvider i18n={core.i18n}>
          {hasProject ? <AppShell /> : <ProjectLauncher />}
        </I18nProvider>
      )}
    </CoreProvider>
  );
}

/** URL 页面路由：bootstrap（启动器） / project（主页面 + 项目 id） */
type AppRoute = { kind: 'bootstrap' } | { kind: 'project'; id: string }

/** 从 URL hash 解析当前页面（默认 bootstrap）：#/project/<id> → 主页面；其余 → 启动器 */
function parseUrl(): AppRoute {
  const m = window.location.hash.match(/^#\/project\/([^/]+)$/)
  return m ? { kind: 'project', id: m[1] } : { kind: 'bootstrap' }
}

/** 把当前页面写入 URL hash（replaceState：不污染浏览器历史堆栈；刷新后据此恢复页面） */
function syncUrl(kind: 'bootstrap' | 'project', id?: string): void {
  const next = kind === 'project' && id ? `#/project/${id}` : '#/bootstrap'
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next)
  }
}

export default App;
