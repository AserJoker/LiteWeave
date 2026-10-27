/**
 * 顶部菜单栏：按菜单注册器（core.menus.list()）渲染菜单，不再硬编码 MENUS 数组。
 *
 * 国际化：菜单文案为 i18n key（menu.xxx.yyy），渲染时用 t() 解析为当前语言字符串。
 * 点击分派：MenuItemDef.command → runCommand(command, commandArgs)；无 command 时走 onClick。
 * 设置弹窗由命令驱动（system.settings:open，由系统插件注册）。
 */
import { useEffect, useState } from 'react';
import { Button, Menu, MenuDivider, MenuItem, PopoverNext } from '@blueprintjs/core';
import { SettingsDialog } from '../settings/SettingsDialog';
import { CreateProjectDialog } from '../launcher/CreateProjectDialog';
import { useI18n } from '../../core/i18n/i18nHooks';
import { useCore } from '../../core/coreContext';
import { CREATE_PROJECT_COMMAND } from '../../core/project/projectModule';
import type { MenuDef, MenuItemDef } from '../../core/plugins/menuRegistry';

/** 设置弹窗命令（系统插件注册；MenuBar 订阅后打开弹窗） */
export const OPEN_SETTINGS_COMMAND = 'system.settings:open';

export function MenuBar(_props: MenuBarProps) {
  const core = useCore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  // 设置弹窗 + 新建项目对话框均由命令驱动（人工点击菜单项 → runCommand → 此处订阅打开）
  useEffect(() => {
    if (!core) return;
    const unsubSettings = core.commands.onCommand(OPEN_SETTINGS_COMMAND, () => setSettingsOpen(true));
    const unsubCreate = core.commands.onCommand(CREATE_PROJECT_COMMAND, () => setCreateProjectOpen(true));
    return () => {
      unsubSettings();
      unsubCreate();
    };
  }, [core]);

  const menus = core?.menus.list() ?? [];

  return (
    <>
      {/* bp6-dark：让 PopoverNext 的 hasDarkParent 检测到暗色，Portal 菜单自动继承暗主题 */}
      <div className="lw-menubar bp6-dark" role="menubar">
        {menus.map((menu) => (
          <MenuDropdown key={menu.i18nKey} menu={menu} />
        ))}
      </div>
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CreateProjectDialog isOpen={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
    </>
  );
}

export interface MenuBarProps {}

function MenuDropdown({ menu }: { menu: MenuDef }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const core = useCore();

  // 点击菜单项：优先命令绑定（runCommand），否则走自定义 onClick
  const handleItemClick = (item: MenuItemDef) => {
    if (!core) return;
    setOpen(false);
    if (item.command) {
      void core.commands.runCommand(item.command, item.commandArgs);
    } else if (item.onClick) {
      item.onClick();
    }
  };

  const content = (
    <Menu>
      {menu.items.map((item, i) => (
        <div key={i}>
          <MenuItem
            text={t(item.i18nKey)}
            icon={item.icon as never}
            label={item.hotkey}
            onClick={() => handleItemClick(item)}
          />
          {item.dividerAfter && <MenuDivider />}
        </div>
      ))}
    </Menu>
  );

  return (
    <PopoverNext
      content={content}
      isOpen={open}
      onInteraction={(next) => setOpen(next)}
      popoverClassName="lw-menubar-popover"
      arrow={false}
      placement="bottom-start"
      renderTarget={({ isOpen: targetOpen, ...targetProps }) => (
        <Button
          {...targetProps}
          minimal
          text={t(menu.i18nKey)}
          role="menuitem"
          className="lw-menubar-item"
          aria-expanded={targetOpen}
          onClick={() => setOpen((o) => !o)}
        />
      )}
    />
  );
}
