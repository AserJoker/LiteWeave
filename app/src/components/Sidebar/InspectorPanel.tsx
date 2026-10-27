/**
 * 检视器面板（占位）。
 *
 * 当前：显示"未选择对象"空态（后续对接真实选择状态）。
 */
import { Icon } from '@blueprintjs/core';

export function InspectorPanel() {
  return (
    <div className="lw-inspector">
      <div className="lw-inspector-empty">
        <Icon icon="properties" size={28} />
        <p>未选择对象</p>
        <span>在资源管理器中选择一个资源以查看其属性</span>
      </div>
    </div>
  );
}
