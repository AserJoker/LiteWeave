/**
 * 右侧边栏：单标签 + 下拉切换容器（当前：检视器 Inspector、历史 History）。
 *
 * 与左侧边栏同构：顶部一行（当前面板标题 + 下拉按钮切换），内容区渲染当前激活面板。
 * 面板来源：按面板注册器（core.panels.list('right')）渲染下拉项 + 内容组件，
 * 不再硬编码面板列表。插件注册面板（side: 'right'）即自动出现在下拉中。
 *
 * 改造（多 tab → 单标签下拉）：原 Blueprint Tabs 在容器宽度变化时需重新计算 tab 宽度，
 * 多面板时 tab 横向滚动体验差；单标签+下拉不受容器宽度影响，且语义更接近"侧边栏活动视图"。
 *
 * 下拉实现：用 Blueprint PopoverNext（基于 floating-ui，定位更稳）。
 * 旧版用 Popover 在按钮位于屏幕右边缘时 transition-container 定位到 (0,0)，
 * PopoverNext 走 floating-ui 的 flip/shift 中间件，自动避让屏幕边缘。
 */
import { Button, Icon, Menu, MenuItem, PopoverNext } from '@blueprintjs/core';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import type { PanelContainerState, PanelId } from '../../core/layout/layoutTypes';

interface RightSidebarProps {
  /** 容器布局状态（受控：激活面板/归属来自 store） */
  layout: PanelContainerState;
  /** 布局变更回调（激活面板切换写回 store） */
  onLayoutChange: (patch: Partial<PanelContainerState>) => void;
}

export function RightSidebar({ layout, onLayoutChange }: RightSidebarProps) {
  const core = useCore();
  const { t } = useI18n();
  const panels = core?.panels.list('right') ?? [];
  const activeId = layout.activePanel as string;
  const activePanel = panels.find((p) => p.id === activeId) ?? panels[0];
  const setActive = (id: string) => onLayoutChange({ activePanel: id as PanelId });

  if (!activePanel) return <div className="lw-sidebar lw-sidebar-right" />;

  const menu = (
    <Menu>
      {panels.map((panel) => (
        <MenuItem
          key={panel.id}
          icon={panel.icon as never}
          text={t(panel.titleKey)}
          active={panel.id === activeId}
          onClick={() => setActive(panel.id)}
        />
      ))}
    </Menu>
  );

  return (
    <div className="lw-sidebar lw-sidebar-right">
      <div className="lw-sidebar-header">
        <div className="lw-sidebar-title">
          <Icon icon={activePanel.icon as never} size={12} />
          <span>{t(activePanel.titleKey)}</span>
        </div>
        {panels.length > 1 && (
          <PopoverNext
            content={menu}
            placement="bottom-end"
            interactionKind="click"
          >
            <Button small minimal icon="caret-down" aria-label="切换面板" />
          </PopoverNext>
        )}
      </div>
      <div className="lw-sidebar-body">
        <ActivePanel id={activePanel.id} panels={panels} />
      </div>
    </div>
  );
}

/** 渲染当前激活面板的内容组件（按注册器查组件） */
function ActivePanel({ id, panels }: { id: string; panels: { id: string; component: React.ComponentType }[] }) {
  const panel = panels.find((p) => p.id === id);
  if (!panel) return null;
  const Component = panel.component;
  return <Component />;
}
