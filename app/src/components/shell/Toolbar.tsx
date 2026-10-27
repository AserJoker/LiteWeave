/**
 * 工具栏：菜单栏下方的一行图标按钮（撤销/重做 + Runner 控制 + 侧边栏切换）。
 *
 * 资源创建/打开由资源管理器右键菜单承担，不在工具栏占位。
 * Runner 控制（启动/停止/重载）经命令通道 system.runner:start/stop/reload 触发，
 * 人工操作与 AI 指令走同一条链路。
 */
import { Button, ButtonGroup, Tooltip } from '@blueprintjs/core';

export type RunnerStatus = 'stopped' | 'starting' | 'ready' | 'running' | 'error'

export interface ToolbarProps {
  /** 是否允许撤销（历史栈是否有可撤销项；由 AppShell 接 core.history） */
  canUndo?: boolean;
  /** 是否允许重做 */
  canRedo?: boolean;
  /** 撤销点击（AppShell 转发到 core.history.undo(activePath)） */
  onUndo?: () => void;
  /** 重做点击 */
  onRedo?: () => void;
  /** 侧边栏切换（由 AppShell 控制） */
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
  /** Runner 状态（用于按钮 active 态与禁用逻辑；缺省=stopped） */
  runnerStatus?: RunnerStatus;
  /** 启动 Runner（点击"运行"按钮 / F5） */
  onRunnerStart?: () => void;
  /** 停止 Runner */
  onRunnerStop?: () => void;
  /** 重载 Runner */
  onRunnerReload?: () => void;
}

interface ToolbarButtonDef {
  icon: string;
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}

export function Toolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  leftSidebarVisible = true,
  rightSidebarVisible = true,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  runnerStatus = 'stopped',
  onRunnerStart,
  onRunnerStop,
  onRunnerReload,
}: ToolbarProps) {
  const editButtons: ToolbarButtonDef[] = [
    { icon: 'undo', label: '撤销', disabled: !canUndo, onClick: onUndo },
    { icon: 'redo', label: '重做', disabled: !canRedo, onClick: onRedo },
  ];

  // Runner 在 running / ready / starting 视为"活动"，可停止；stopped/error 视为"未活动"，可启动
  const runnerActive = runnerStatus === 'running' || runnerStatus === 'ready' || runnerStatus === 'starting';
  // 状态指示色：stopped=灰、starting=橙、ready=蓝、running=绿、error=红
  const runnerStatusColor = {
    stopped: '#5f6b7c',
    starting: '#f5b041',
    ready: '#48aff0',
    running: '#3dcc91',
    error: '#f55656',
  }[runnerStatus];
  const runnerStatusLabel = {
    stopped: '已停止',
    starting: '启动中',
    ready: '已就绪',
    running: '运行中',
    error: '异常',
  }[runnerStatus];

  return (
    <div className="lw-toolbar">
      <ButtonGroup minimal>
        {editButtons.map((b) => (
          <Tooltip key={b.label} content={b.label} placement="bottom">
            <Button minimal icon={b.icon as never} disabled={b.disabled} onClick={b.onClick} />
          </Tooltip>
        ))}
      </ButtonGroup>

      {/* Runner 控制：启动 / 停止 / 重载 + 状态指示 */}
      <ButtonGroup minimal className="lw-toolbar-runner-group">
        <Tooltip content={runnerActive ? `运行中（${runnerStatusLabel}）— 点击重载` : '启动 Runner（F5）'} placement="bottom">
          <Button
            minimal
            icon="play"
            intent={runnerActive ? 'success' : undefined}
            active={runnerActive}
            disabled={runnerStatus === 'starting'}
            onClick={runnerActive ? onRunnerReload : onRunnerStart}
          />
        </Tooltip>
        <Tooltip content="停止 Runner" placement="bottom">
          <Button minimal icon="stop" disabled={!runnerActive} onClick={onRunnerStop} />
        </Tooltip>
        {/* 状态指示圆点（非 stopped 时显示） */}
        {runnerStatus !== 'stopped' && (
          <Tooltip content={`Runner: ${runnerStatusLabel}`} placement="bottom">
            <span className="lw-toolbar-runner-dot" style={{ backgroundColor: runnerStatusColor }} />
          </Tooltip>
        )}
      </ButtonGroup>

      <div className="lw-toolbar-spacer" />

      <ButtonGroup minimal className="lw-toolbar-layout-group">
        {/* 左侧边栏：图标随开/关切换，文案用位置语义 */}
        <Tooltip content={leftSidebarVisible ? '收起左侧边栏' : '展开左侧边栏'} placement="bottom">
          <Button
            minimal
            active={leftSidebarVisible}
            icon={leftSidebarVisible ? 'layout-left-column-two-tiles' : 'layout-two-columns'}
            onClick={onToggleLeftSidebar}
          />
        </Tooltip>
        {/* 右侧边栏：图标随开/关切换，文案用位置语义 */}
        <Tooltip content={rightSidebarVisible ? '收起右侧边栏' : '展开右侧边栏'} placement="bottom">
          <Button
            minimal
            active={rightSidebarVisible}
            icon={rightSidebarVisible ? 'layout-right-column-two-tiles' : 'layout-two-columns'}
            onClick={onToggleRightSidebar}
          />
        </Tooltip>
      </ButtonGroup>
    </div>
  );
}
