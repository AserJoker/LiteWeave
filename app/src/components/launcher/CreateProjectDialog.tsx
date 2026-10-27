/**
 * CreateProjectDialog —— 新建项目对话框（独立组件，供编辑器内菜单使用）。
 *
 * 与启动器（ProjectLauncher）共享同一 schema 和创建逻辑，但本组件不依赖启动器上下文，
 * 可在编辑器内通过订阅 CREATE_PROJECT_COMMAND 打开。
 *
 * 创建成功后由 core.project.create 自动打开新项目（PROJECT_OPENED 广播 → App 切换）。
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, Intent } from '@blueprintjs/core';
import { SchemaForm } from '../../core/schema/schemaForm';
import { createMemoryStore, type FormStore } from '../../core/schema/formStore';
import { CREATE_PROJECT_SCHEMA_ID } from '../../core/schema/schemaLauncher';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import type { ProjectType } from '../../core/project/projectModule';

/** 项目名 → 默认命名空间（小写化 + 去非法字符；与主进程 defaultNamespaceFromName 一致） */
function defaultNamespace(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return base.length > 0 && /^[a-zA-Z]/.test(base) ? base : 'main';
}

interface CreateProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ isOpen, onClose }: CreateProjectDialogProps) {
  const core = useCore();
  const { t } = useI18n();

  const [store, setStore] = useState<FormStore | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  const schema = core?.schemas.get(CREATE_PROJECT_SCHEMA_ID);

  // 对话框打开时（isOpen: false→true）初始化 store；关闭时清理（避免复用旧值）
  useEffect(() => {
    if (!isOpen) {
      setStore(undefined);
      setError(undefined);
      return;
    }
    let namespaceTouched = false;
    const inner = createMemoryStore({ name: '', type: '2d', defaultNamespace: '' });
    const s: FormStore = {
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
    setStore(s);
  }, [isOpen]);

  const handleClose = () => {
    setStore(undefined);
    setError(undefined);
    onClose();
  };

  const handleCreate = async () => {
    if (!core || !store) return;
    const name = String(store.get('name') ?? '').trim();
    if (!name) return;
    const type = (store.get('type') as ProjectType | undefined) ?? '2d';
    const ns = String(store.get('defaultNamespace') ?? '').trim() || undefined;
    setCreating(true);
    setError(undefined);
    try {
      const result = await core.project.create({ name, type, defaultNamespace: ns });
      if (result.error) {
        setError(result.error);
      } else {
        // 创建成功：core.project.create 已自动打开新项目（PROJECT_OPENED 广播）
        setStore(undefined);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title={t('system.launcher.newProject')}
      icon="new-object"
      canOutsideClickClose={false}
      className="bp6-dark"
    >
      <div className="lw-launcher-create">
        {schema && store && (
          <SchemaForm
            schema={schema.schema}
            store={store}
            t={t}
            renderers={core?.schemaRenderers}
          />
        )}
        {error && <div className="lw-launcher-error">{error}</div>}
      </div>
      <div className="bp6-dialog-footer-actions lw-launcher-create-footer">
        <Button text={t('system.launcher.cancel')} onClick={handleClose} />
        <Button
          text={t('system.launcher.create')}
          intent={Intent.PRIMARY}
          loading={creating}
          onClick={() => void handleCreate()}
        />
      </div>
    </Dialog>
  );
}
