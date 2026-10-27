/**
 * 底部状态栏：显示当前状态占位文本 + 右侧小信息（行/列、语言等占位）。
 */
import { Icon } from '@blueprintjs/core';

export interface StatusBarProps {
  /** 左侧状态消息 */
  message?: string;
  /** 右侧附加信息项，例如 { label: '行 1, 列 1' } */
  items?: { key: string; text: string; icon?: string }[];
}

export function StatusBar({
  message = '就绪',
  items = [{ key: 'cursor', text: '行 1, 列 1' }],
}: StatusBarProps) {
  return (
    <footer className="lw-statusbar">
      <div className="lw-statusbar-message">
        <Icon icon="info-sign" size={12} />
        <span>{message}</span>
      </div>
      <div className="lw-statusbar-spacer" />
      <div className="lw-statusbar-items">
        {items.map((item) => (
          <span key={item.key} className="lw-statusbar-item">
            {item.icon && <Icon icon={item.icon as never} size={12} />}
            {item.text}
          </span>
        ))}
      </div>
    </footer>
  );
}
