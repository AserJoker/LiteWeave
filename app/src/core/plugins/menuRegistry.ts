/**
 * 菜单注册器 —— 顶部菜单栏项声明（含命令绑定）。
 *
 * 设计（见 docs/design/plugin-system.md §4.4）：
 * - MenuBar 原用静态 MENUS 数组 + switch(i18nKey) 手动分发；
 *   改为按注册表渲染 + MenuItemDef.command 绑定命令。
 * - 插件可 register 新菜单或 append 进既有菜单。
 */
/** 菜单项定义：i18n key + 图标 + 快捷键 + 命令绑定/自定义点击 */
export interface MenuItemDef {
  /** 菜单项 i18n key */
  i18nKey: string
  icon?: string
  hotkey?: string
  dividerAfter?: boolean
  /** 点击时执行的命令（命令名带命名空间，如 system.project:open）；与 onClick 二选一 */
  command?: string
  /** 命令参数（可选） */
  commandArgs?: unknown
  /** 或自定义点击处理（与 command 二选一，优先 command） */
  onClick?: () => void
}

/** 菜单定义：菜单名 i18n key + 项列表 */
export interface MenuDef {
  /** 菜单名 i18n key（如 system.menu.name.file） */
  i18nKey: string
  items: MenuItemDef[]
}

/** 菜单注册器接口（挂 PluginContext.menus，插件 init 时注册） */
export interface MenuRegistry {
  /** 注册一个菜单；i18nKey 为空 / 重复报错 */
  register(menu: MenuDef): void
  /** 全部已注册菜单（按注册顺序） */
  list(): MenuDef[]
  /** 向既有菜单追加项（插件扩展既有菜单）；菜单不存在时警告并忽略 */
  append(menuKey: string, item: MenuItemDef): void
  /** 移除（供测试/卸载） */
  unregister(menuKey: string): void
}

/** 创建菜单注册器（core 内置；由 createCore 实例化并挂到 ctx） */
export function createMenuRegistry(): MenuRegistry {
  const menus = new Map<string, MenuDef>()

  return {
    register(menu: MenuDef): void {
      if (!menu || typeof menu.i18nKey !== 'string' || !menu.i18nKey) {
        throw new Error('[menu] 菜单定义缺少有效 i18nKey')
      }
      if (menus.has(menu.i18nKey)) {
        throw new Error(`[menu] 菜单 "${menu.i18nKey}" 已注册，不能重复注册`)
      }
      menus.set(menu.i18nKey, { ...menu, items: [...menu.items] })
    },

    list(): MenuDef[] {
      return Array.from(menus.values())
    },

    append(menuKey: string, item: MenuItemDef): void {
      const menu = menus.get(menuKey)
      if (!menu) {
        console.warn(`[menu] 尝试向未注册菜单 "${menuKey}" 追加项，忽略`)
        return
      }
      menu.items.push(item)
    },

    unregister(menuKey: string): void {
      menus.delete(menuKey)
    },
  }
}
