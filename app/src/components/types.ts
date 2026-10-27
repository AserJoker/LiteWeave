/**
 * 共享 UI 类型定义 —— 供布局骨架各组件复用，方便后续把真实编辑器注册进槽位。
 */

/** 已打开的资源编辑器标签页（后续可扩展为真实的编辑器实例描述）。 */
export interface EditorTab {
  /** 唯一 id，例如 "welcome"、"scene:level1"、"system.project-config:project.json" */
  id: string;
  /** 标签标题 */
  title: string;
  /** 资源类型 id（如 system.project-config）；WorkspaceTabs 按它分派到对应 EditorPanel（未匹配用默认占位） */
  type?: string;
  /** 图标名（Blueprint icon name） */
  icon?: string;
  /** 文件路径或资源定位符，用于状态栏提示 */
  path?: string;
  /** 是否可关闭（欢迎页通常不可关闭） */
  closable?: boolean;
}

/** 资源树节点（占位用，后续可对接真实的资源管理器数据）。 */
export interface ResourceNode {
  id: string;
  label: string;
  icon?: string;
  children?: ResourceNode[];
}

/** 左右侧边栏的通用槽位配置。 */
export interface SidebarState {
  visible: boolean;
  width: number;
}
