/**
 * 中间主编辑区：VSCode 风格的多标签页（Tab 栏 + 内容区）。
 * 已打开的编辑器标签由上层通过 `tabs` 传入；欢迎页默认常驻且不可关闭。
 *
 * 编辑器分派：按 tab.type（资源类型 id）查编辑器注册器分发到对应编辑器组件；
 * 未匹配（或欢迎页）用内置占位。插件注册资源类型 + 编辑器即完成扩展，无需改本组件。
 */
import { Button, Icon } from '@blueprintjs/core';
import type { EditorTab } from '../types';
import { useCore } from '../../core/coreContext';

interface WorkspaceTabsProps {
  tabs: EditorTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  onTabClose: (id: string) => void;
}

/** 渲染当前活动标签对应的面板内容：欢迎页 / 按资源类型查编辑器注册器 / 占位。 */
function renderPanel(tab: EditorTab, core: ReturnType<typeof useCore>) {
  if (tab.id === 'welcome') {
    return (
      <div className="lw-welcome">
        <Icon icon="application" size={40} />
        <h1>LiteWeave</h1>
        <p>轻引擎 · 重脚本 · 数据驱动的资源编辑器 IDE</p>
        <p className="lw-welcome-hint">在左侧资源管理器中选择资源即可打开编辑器（占位）</p>
      </div>
    );
  }

  // 资源类型 → 编辑器注册器分派（未匹配走占位；插件注册后自动可渲染）
  if (tab.type) {
    const editor = core?.editors.get(tab.type);
    if (editor) {
      return editor({ type: tab.type, tab });
    }
  }

  return (
    <div className="lw-editor-panel">
      <div className="lw-editor-placeholder">
        <Icon icon="document" size={28} />
        <p>“{tab.title}”的编辑器尚未实现（占位）</p>
      </div>
    </div>
  );
}

export function WorkspaceTabs({ tabs, activeTabId, onTabChange, onTabClose }: WorkspaceTabsProps) {
  const core = useCore();
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className="lw-workspace">
      <div className="lw-tabbar" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={active ? 'lw-tab lw-tab-active' : 'lw-tab'}
              onClick={() => onTabChange(tab.id)}
              title={tab.path ?? tab.title}
            >
              {tab.icon && <Icon icon={tab.icon as never} size={12} />}
              <span className="lw-tab-title">{tab.title}</span>
              {tab.closable !== false && (
                <Button
                  className="lw-tab-close"
                  minimal
                  small
                  icon="cross"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="lw-workspace-body">{activeTab && renderPanel(activeTab, core)}</div>
    </div>
  );
}