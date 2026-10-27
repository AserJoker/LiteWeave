/**
 * ProjectLauncher —— 启动器界面（类 Unity Hub）。
 *
 * 形态：启动时若未打开项目，显示启动器；打开项目后进入编辑器（App.tsx 切换）。
 *
 * 职责：
 * - 展示项目列表（名称 / 更新时间 / 打开按钮）
 * - 新建项目（名称输入 → system.project:create）
 * - 导入 .liteweave 项目包（system.project:import，弹系统文件框）
 * - 每项目：导出（system.project:export）/ 删除（system.project:remove，二次确认）
 *
 * 数据：core.project（ProjectApi），订阅 system.project:list-changed / system.project:opened 刷新。
 * 空态：无项目时显示引导（新建 / 导入）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Dialog, Icon, Intent, MenuItem } from '@blueprintjs/core';
import { Select2 } from '@blueprintjs/select';
import { SchemaForm } from '../../core/schema/schemaForm';
import { createMemoryStore, type FormStore } from '../../core/schema/formStore';
import { CREATE_PROJECT_SCHEMA_ID } from '../../core/schema/schemaLauncher';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import { SETTINGS_SET_COMMAND } from '../../core/store/storeModule';
import {
  CREATE_PROJECT_COMMAND,
  IMPORT_PROJECT_COMMAND,
  PROJECT_LIST_CHANGED,
  PROJECT_OPENED,
} from '../../core/project/projectModule';
import type { ProjectMeta, ProjectType } from '../../core/project/projectModule';

/** 语言字段完整设置路径（与设置对话框一致，持久化到 settings.json） */
const LANGUAGE_SETTING_PATH = 'system.general.appearance.language';

/** 语言切换下拉选项（Select2 项类型） */
interface LocaleOption {
  value: string;
  label: string;
}

/** 取带参数 i18n 文案：t('...{x}...', { x }) 简单插值 */
function tr(t: (k: string) => string, key: string, params?: Record<string, string>): string {
  let s = t(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}

/** 项目名 → 默认命名空间（小写化 + 去非法字符；与主进程 defaultNamespaceFromName 一致） */
function defaultNamespace(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return base.length > 0 && /^[a-zA-Z]/.test(base) ? base : 'main';
}

/** 格式化 ISO 时间为 YYYY-MM-DD HH:mm */
function formatTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ProjectLauncher() {
  const core = useCore();
  const { t, locale, setLocale } = useI18n();

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  // 新建项目表单值由 SchemaForm + createMemoryStore 承载（本地编辑，确定时提交，不落 store）
  const [createStore, setCreateStore] = useState<FormStore | undefined>(undefined);
  const [createError, setCreateError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectMeta | undefined>();
  const [removing, setRemoving] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | undefined>();

  // 创建项目表单 schema（从注册器取用；后续可被插件 patch）
  const createSchema = core?.schemas.get(CREATE_PROJECT_SCHEMA_ID);

  // 语言切换下拉选项（i18n 已注册的语言列表；core 未就绪时为空数组）
  const localeOptions: LocaleOption[] =
    core?.i18n.getLocales().map((l) => ({ value: l.id, label: l.displayName })) ?? [];

  // 打开新建项目对话框：创建内存 store（值不落 store，确定时提交）；name→defaultNamespace 联动
  const openCreate = () => {
    setCreateError(undefined);
    // 用闭包包装 createMemoryStore：name 变更时若命名空间未被手改，随项目名联动默认值
    let namespaceTouched = false;
    const inner = createMemoryStore({ name: '', type: '2d', defaultNamespace: '' });
    const store: FormStore = {
      get: (k) => inner.get(k),
      set: (k, v) => {
        inner.set(k, v);
        if (k === 'name' && !namespaceTouched) {
          inner.set('defaultNamespace', defaultNamespace(String(v ?? '')));
        }
        if (k === 'defaultNamespace') {
          namespaceTouched = true;
        }
      },
      subscribe: (l) => inner.subscribe(l),
    };
    setCreateStore(store);
    setCreateOpen(true);
  };

  const refresh = useCallback(async () => {
    if (!core) return;
    try {
      const list = await core.project.list();
      setProjects(list);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [core]);

  // 首次加载 + 订阅列表变更。首屏用 async IIFE（await 后 setState，非 effect 同步段）
  useEffect(() => {
    if (!core) return;
    void (async () => {
      try {
        const list = await core.project.list();
        setProjects(list);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    return core.project.subscribe((event) => {
      if (event === PROJECT_LIST_CHANGED || event === PROJECT_OPENED) {
        void refresh();
      }
    });
  }, [core, refresh]);

  const handleCreate = async () => {
    if (!core || !createStore) return;
    const name = String(createStore.get('name') ?? '').trim();
    if (!name) return;
    const type = (createStore.get('type') as ProjectType | undefined) ?? '2d';
    const ns = String(createStore.get('defaultNamespace') ?? '').trim() || undefined;
    setCreating(true);
    setCreateError(undefined);
    try {
      await core.project.create({ name, type, defaultNamespace: ns });
      setCreateOpen(false);
      setCreateStore(undefined);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleOpen = async (id: string) => {
    if (!core || busyId) return;
    setBusyId(id);
    setErrorMsg(undefined);
    try {
      const r = await core.project.open(id);
      if (r.error && r.error !== 'not-in-electron') {
        setErrorMsg(r.error);
      }
    } finally {
      setBusyId(undefined);
    }
  };

  const handleImport = async () => {
    if (!core || busyId) return;
    setBusyId('__import__');
    setErrorMsg(undefined);
    try {
      const r = await core.project.import();
      if (r.error && r.error !== 'not-in-electron') {
        setErrorMsg(r.error);
      }
    } finally {
      setBusyId(undefined);
    }
  };

  const handleExport = async (p: ProjectMeta) => {
    if (!core || busyId) return;
    setBusyId(p.id);
    setErrorMsg(undefined);
    try {
      const r = await core.project.export(p.id);
      if (r.error && r.error !== 'not-in-electron') {
        setErrorMsg(r.error);
      }
    } finally {
      setBusyId(undefined);
    }
  };

  // 语言切换：即时生效（setLocale）+ 持久化到 settings（与设置对话框同一路径，重启恢复）
  const handleLanguageChange = (value: string) => {
    if (!core || value === locale) return;
    setLocale(value);
    void core.commands.runCommand(SETTINGS_SET_COMMAND, { key: LANGUAGE_SETTING_PATH, value });
  };

  const handleRemove = async () => {
    if (!core || !removeTarget || removing) return;
    setRemoving(true);
    try {
      const r = await core.project.remove(removeTarget.id);
      if (r.error) {
        setErrorMsg(r.error);
      }
      setRemoveTarget(undefined);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="lw-launcher bp6-dark">
      <div className="lw-launcher-header">
        <div className="lw-launcher-brand">
          <Icon icon="applications" size={20} />
          <span>LiteWeave</span>
        </div>
        <div className="lw-launcher-header-right">
          {/* 语言切换：常驻右上角（空态也显示），切换走 i18n.setLocale → 持久化 + 界面实时更新 */}
          <Select2<LocaleOption>
            className="lw-launcher-lang"
            items={localeOptions}
            filterable={false}
            activeItem={localeOptions.find((o) => o.value === locale)}
            onItemSelect={(item) => handleLanguageChange(item.value)}
            itemRenderer={(item, { handleClick, modifiers }) => (
              <MenuItem
                key={item.value}
                role="option"
                text={item.label}
                active={modifiers.active}
                onClick={handleClick}
              />
            )}
            popoverProps={{ matchTargetWidth: true, minimal: true }}
          >
            <Button
              text={localeOptions.find((o) => o.value === locale)?.label ?? ''}
              rightIcon="caret-down"
              alignText="left"
            />
          </Select2>
          {/* 空态时右上角不显示（屏幕正中已有新建/导入引导） */}
          {!loading && projects.length > 0 && (
            <div className="lw-launcher-actions">
              <Button icon="new-object" text={t('system.launcher.newProject')} intent={Intent.PRIMARY} onClick={openCreate} />
              <Button icon="import" text={t('system.launcher.importProject')} onClick={() => void handleImport()} />
            </div>
          )}
        </div>
      </div>

      <div className="lw-launcher-body">
        {loading ? (
          <div className="lw-launcher-empty">{t('system.launcher.loading')}</div>
        ) : projects.length === 0 ? (
          <div className="lw-launcher-empty">
            <Icon icon="folder-open" size={40} />
            <p>{t('system.launcher.emptyTitle')}</p>
            <div className="lw-launcher-empty-actions">
              <Button icon="new-object" text={t('system.launcher.newProject')} intent={Intent.PRIMARY} onClick={openCreate} />
              <Button icon="import" text={t('system.launcher.importProject')} onClick={() => void handleImport()} />
            </div>
          </div>
        ) : (
          <div className="lw-launcher-list">
            {projects.map((p) => (
              <Card
                key={p.id}
                className="lw-launcher-item"
                interactive={false}
                onDoubleClick={() => void handleOpen(p.id)}
              >
                <div className="lw-launcher-item-main">
                  <Icon icon="folder-close" size={18} className="lw-launcher-item-icon" />
                  <div className="lw-launcher-item-info">
                    <div className="lw-launcher-item-name">{p.name}</div>
                    <div className="lw-launcher-item-meta">
                      <span>{tr(t, 'system.launcher.updatedAt', { time: formatTime(p.updatedAt) })}</span>
                    </div>
                  </div>
                </div>
                <div className="lw-launcher-item-actions">
                  <Button
                    icon="export"
                    text={t('system.launcher.export')}
                    minimal
                    loading={busyId === p.id}
                    onClick={() => void handleExport(p)}
                  />
                  <Button
                    icon="trash"
                    text={t('system.launcher.remove')}
                    minimal
                    intent={Intent.DANGER}
                    onClick={() => setRemoveTarget(p)}
                  />
                  <Button
                    icon="folder-open"
                    text={t('system.launcher.open')}
                    intent={Intent.PRIMARY}
                    loading={busyId === p.id}
                    onClick={() => void handleOpen(p.id)}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="lw-launcher-footer">
        {errorMsg && <span className="lw-launcher-error">{errorMsg}</span>}
      </div>

      {/* 新建项目对话框 */}
      <Dialog
        isOpen={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreateStore(undefined);
          setCreateError(undefined);
        }}
        title={t('system.launcher.newProject')}
        icon="new-object"
        canOutsideClickClose={false}
        className="bp6-dark"
      >
        <div className="lw-launcher-create">
          {createSchema && createStore && (
            <SchemaForm
              schema={createSchema.schema}
              store={createStore}
              t={t}
              renderers={core?.schemaRenderers}
            />
          )}
          {createError && <div className="lw-launcher-error">{createError}</div>}
        </div>
        <div className="bp6-dialog-footer-actions lw-launcher-create-footer">
          <Button text={t('system.launcher.cancel')} onClick={() => setCreateOpen(false)} />
          <Button text={t('system.launcher.create')} intent={Intent.PRIMARY} loading={creating} onClick={() => void handleCreate()} />
        </div>
      </Dialog>

      {/* 删除确认 */}
      <Alert
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(undefined)}
        onConfirm={() => void handleRemove()}
        confirmButtonText={t('system.launcher.removeConfirmOk')}
        cancelButtonText={t('system.launcher.removeConfirmCancel')}
        intent={Intent.DANGER}
        loading={removing}
        canOutsideClickCancel
        className="bp6-dark"
      >
        <p>{tr(t, 'system.launcher.removeConfirmBody', { name: removeTarget?.name ?? '' })}</p>
      </Alert>
    </div>
  );
}

/** 供外部判断是否使用启动器的占位命令（避免未使用告警） */
export const LAUNCHER_OPEN_COMMAND = CREATE_PROJECT_COMMAND;
export const LAUNCHER_IMPORT_COMMAND = IMPORT_PROJECT_COMMAND;
