/**
 * ProjectConfigEditor —— project.json 的可视化配置编辑器（第一个“文件→类型→编辑器”落地）。
 *
 * 链路：
 * - 资源树点击 project.json → system.resource:open 命令 → AppShell 按资源类型匹配
 *   → WorkspaceTabs 按 tab.type 分派到本组件（标签 type = system.project-config）
 * - 数据：挂载时 core.project.loadConfig() 拉磁盘全量到 cache；SchemaForm 改字段
 *   → FormStore.set → 组装 patch（扁平值 → 嵌套）→ system.project:config:set 命令
 *   → 主进程 updateMeta 写盘 → 回推 system.project:config:changed → cache 更新 → 本组件重渲染
 * - 自动化（AI/MCP）：与人工同链路 —— system.resource:open 打开、system.project:config:set 写配置。
 *
 * 只读元信息（id/formatVersion/createdAt/updatedAt）单独展示；可编辑字段走 SchemaForm。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Icon, Intent, Tag } from '@blueprintjs/core';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import { SchemaForm, type FormValues, type Schema } from '../../core/schema/schemaForm';
import type { FormStore } from '../../core/schema/formStore';
import { PROJECT_CONFIG_SCHEMA_ID } from '../../core/schema/schemaProjectConfig';
import { projectMetaToForm, projectFormToPatch } from '../../core/schema/schemaProjectConfig';
import { parseLangListValue, type LangEntry } from '../../core/schema/schemaBuiltinRenderers';
import { PROJECT_CONFIG_CHANGED, SET_PROJECT_CONFIG_COMMAND } from '../../core/project/projectModule';
import type { ProjectMeta } from '../../core/project/projectModule';
import { pushSnapshot, recordBaseline, configToForm } from '../../core/project/projectConfigHistory';

/** 取带参数 i18n 文案：t('...{x}...', { x }) 简单插值（与 ProjectLauncher 本地函数一致） */
function tr(t: (k: string) => string, key: string, params?: Record<string, string>): string {
  let s = t(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}

/** 本地编辑覆盖：字段 key → 用户改动值（回推确认后清除，回到 cache 权威） */
type LocalEdit = Partial<Record<string, unknown>>;

interface ProjectConfigEditorProps {
  /** 标签的 path（当前是 project.json 的虚拟路径） */
  path?: string;
}

/** 由 schema 查找字段 labelKey（用于历史项显示名）；扁平 key 如 settings.rendering.targetFps */
function collectLabelKey(schema: Schema | undefined, key: string): string | undefined {
  if (!schema) return undefined
  for (const child of schema) {
    if (child.kind === 'field' && child.field.key === key) {
      return typeof child.field.labelKey === 'string' ? child.field.labelKey : undefined
    }
    if (child.kind === 'group') {
      const nested = collectLabelKey(child.children, key)
      if (nested) return nested
    }
  }
  return undefined
}

export function ProjectConfigEditor({ path }: ProjectConfigEditorProps) {
  const core = useCore();
  const { t } = useI18n();
  const schema = core?.schemas.get(PROJECT_CONFIG_SCHEMA_ID);
  const [localEdit, setLocalEdit] = useState<LocalEdit>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string>();
  const [error, setError] = useState<string>();
  // 待命历史：写盘确认后 push（避免重复记录；失败清除）
  const pendingHistoryRef = useRef<{ label: string } | null>(null);
  // 待删除语言联动：pendingRemove = { id, files } 时弹 Alert 确认一并删除关联 .lang
  const [pendingRemove, setPendingRemove] = useState<{ id: string; files: string[] }>();
  // 待提交的语言 patch（Alert 确认后写入：languages 列表 + 逐个删 .lang 文件）
  const pendingCommitRef = useRef<{ value: string } | null>(null);

  // 挂载：拉取磁盘全量到 cache（幂等；若已加载则直接返回最新 cache）
  useEffect(() => {
    if (!core) return;
    void core.project.loadConfig().catch((err) => {
      console.error('[project-config] 加载 project.json 失败:', err);
      setError(String(err));
    });
  }, [core]);

  // 订阅 config 变更（回推确认 / 加载完成）→ 重渲染（SchemaForm 重新 get）+ 清除已确认字段的本地编辑
  useEffect(() => {
    if (!core) return;
    return core.events.subscribe(PROJECT_CONFIG_CHANGED, () => {
      setLocalEdit({});
      setSaving(false);
      setSaveMsg('saved');
      setTimeout(() => setSaveMsg(undefined), 1500);
      const cfg = core?.project.getConfig();
      // 加载完成（无待命历史）：记录初始扁平值作为 undo 基线（currentIndex=-1 时还原）
      if (!pendingHistoryRef.current && path && cfg) {
        recordBaseline(path, configToForm(cfg as unknown as Record<string, unknown>));
      }
      // 写盘确认后：若有待命历史（用户改动），push 快照（截断 redo 分支 + 指针移末尾 + 同步框架镜像）
      if (pendingHistoryRef.current) {
        const { label } = pendingHistoryRef.current;
        pendingHistoryRef.current = null;
        if (cfg && path) {
          pushSnapshot(
            path,
            { label, flat: configToForm(cfg as unknown as Record<string, unknown>) },
            core?.history,
          );
        }
      }
    });
  }, [core, path]);

  const meta = core?.project.getConfig();

  /** 提交变更：扁平值 → 嵌套 patch → system.project:config:set 命令（人工/AI 同链路）；返回完成 Promise */
  const commitChange = useCallback(
    (partial: Record<string, unknown>): Promise<void> | undefined => {
      if (!core) return undefined;
      setSaving(true);
      setError(undefined);
      // 记录待命历史（写盘确认后 push；label 取字段显示名）
      const keys = Object.keys(partial);
      if (keys.length === 1) {
        const labelKey = collectLabelKey(schema?.schema, keys[0]);
        pendingHistoryRef.current = {
          label: labelKey ? t(labelKey) : keys[0],
        };
      }
      const patch = projectFormToPatch(partial as FormValues);
      return core.commands
        .runCommand(SET_PROJECT_CONFIG_COMMAND, { patch })
        .then(() => {
          // 写盘成功由 PROJECT_CONFIG_CHANGED 回推清除本地编辑；这里只关 saving
        })
        .catch((err) => {
          console.error('[project-config] 保存失败:', err);
          setError(String(err));
          setSaving(false);
          pendingHistoryRef.current = null;
        });
    },
    [core, schema, t],
  );

  /** 删除语言确认（Alert 弹窗）——确认后：先提交 languages patch，再逐个删除关联 .lang 文件（串行防 TOCTOU 竞态） */
  const handleConfirmRemoveLang = useCallback(() => {
    const pending = pendingCommitRef.current;
    if (!core || !pending) {
      setPendingRemove(undefined);
      return;
    }
    pendingCommitRef.current = null;
    const { value } = pending;
    const files = pendingRemove?.files ?? [];
    setPendingRemove(undefined);
    // 提交 languages 列表变更（写盘完成后再删文件，避免两处写 project.json 互相覆盖）
    setLocalEdit((prev) => ({ ...prev, languages: value }));
    void (commitChange({ languages: value }) ?? Promise.resolve()).then(() => {
      // 一并删除关联 .lang 文件（逐个；失败不阻塞，但记录错误）
      for (const f of files) {
        void core.project
          .deleteFile(f)
          .then((r) => {
            if (!r.ok) console.error('[project-config] 删除语言文件失败:', f, r.error);
          })
          .catch((err) => console.error('[project-config] 删除语言文件失败:', f, err));
      }
    });
  }, [core, commitChange, pendingRemove]);

  /** 取消删除语言：回滚本地编辑（不提交） */
  const handleCancelRemoveLang = useCallback(() => {
    pendingCommitRef.current = null;
    setPendingRemove(undefined);
    // 渲染器已乐观更新 UI（localEdit 覆盖），回滚让它回到 cache 权威值
    setLocalEdit((prev) => {
      const next = { ...prev };
      delete next.languages;
      return next;
    });
  }, []);

  // 表单值快照：cache（权威）转扁平值，未设字段用 schema 默认值兜底（SchemaForm 内部处理）；
  // 这里把 cache 值转扁平后交给 FormStore，SchemaForm 再兜底默认值。
  const formStore: FormStore | undefined = useMemo(() => {
    if (!core) return undefined;
    return {
      get: (key) => {
        // 本地编辑优先（未确认的改动立即反映 UI）
        const edit = localEdit[key];
        if (edit !== undefined) return edit as FormValues[string];
        // 否则从 cache（磁盘权威）读
        const cfg = core.project.getConfig();
        if (!cfg) return undefined;
        const flat = projectMetaToForm(cfg as unknown as Record<string, unknown>);
        return flat[key];
      },
      set: (key, value) => {
        // 语言列表删除联动：删除某语言时，检查是否有对应 .lang 文件，有则弹 Alert 确认一并删除
        if (key === 'languages') {
          const cfg = core.project.getConfig();
          const oldLangs: LangEntry[] = Array.isArray((cfg as unknown as Record<string, unknown>)?.languages)
            ? ((cfg as unknown as { languages?: LangEntry[] }).languages ?? [])
            : [];
          const oldIds = oldLangs.map((l) => l.id);
          const newIds = parseLangListValue(typeof value === 'string' ? value : undefined).map((l) => l.id);
          const removedIds = oldIds.filter((id) => id && !newIds.includes(id));
          if (removedIds.length > 0) {
            // 关联 .lang 文件：资源清单中 type==='i18n' 且文件名 = <id>.lang
            const resources = (cfg as unknown as { resources?: Array<{ type: string; path: string }> })?.resources ?? [];
            const files = resources
              .filter((r) => r.type === 'i18n' && removedIds.some((id) => r.path.endsWith(`${id}.lang`)))
              .map((r) => r.path);
            if (files.length > 0) {
              // 有关联文件：暂存待提交，弹 Alert 确认（取消则回滚本地编辑，不提交）
              const removed = removedIds.find((id) => files.some((f) => f.endsWith(`${id}.lang`)));
              pendingCommitRef.current = { value: String(value) };
              setPendingRemove({ id: removed ?? removedIds[0], files });
              return;
            }
          }
        }
        // 普通写入 / 无关联文件的删除：记录本地编辑（立即反映）+ 组装 patch 提交
        setLocalEdit((prev) => ({ ...prev, [key]: value }));
        commitChange({ [key]: value });
      },
      subscribe: (listener) => {
        return core.events.subscribe(PROJECT_CONFIG_CHANGED, () => listener());
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, localEdit, schema]);

  // 只读元信息展示
  const metaInfo = useMemo(() => {
    if (!meta) return undefined;
    const m = meta as ProjectMeta;
    return [
      { label: t('system.projectConfig.field.formatVersion'), value: String(m.formatVersion ?? '') },
      { label: t('system.projectConfig.field.createdAt'), value: m.createdAt ?? '' },
      { label: t('system.projectConfig.field.updatedAt'), value: m.updatedAt ?? '' },
    ];
  }, [meta, t]);

  if (!core || !schema) {
    return (
      <div className="lw-editor-panel lw-project-config">
        <div className="lw-editor-placeholder">
          <Icon icon="cog" size={28} />
          <p>{t('system.projectConfig.title')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lw-editor-panel lw-project-config">
      <div className="lw-project-config-header">
        <div className="lw-project-config-title">
          <Icon icon="cog" size={16} />
          <span>project.json</span>
          {path && <span className="lw-project-config-path">{path}</span>}
        </div>
        <div className="lw-project-config-status">
          {saving && <Tag minimal intent="primary" icon="refresh">{t('system.common.save')}…</Tag>}
          {saveMsg && !saving && <Tag minimal intent="success" icon="tick">{t('system.projectConfig.saved')}</Tag>}
          {error && <Tag minimal intent="danger" icon="error">{error}</Tag>}
        </div>
      </div>

      {metaInfo && (
        <div className="lw-project-config-meta">
          {metaInfo.map((info) => (
            <div key={info.label} className="lw-project-config-meta-item">
              <span className="lw-project-config-meta-label">{info.label}</span>
              <span className="lw-project-config-meta-value">{info.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="lw-project-config-body">
        <SchemaForm schema={schema.schema} store={formStore!} t={t} renderers={core?.schemaRenderers} />
      </div>

      {/* 删除语言确认弹窗：存在关联 .lang 文件时提示一并删除 */}
      <Alert
        isOpen={!!pendingRemove}
        onClose={handleCancelRemoveLang}
        onConfirm={() => void handleConfirmRemoveLang()}
        confirmButtonText={t('system.projectConfig.field.languageRemove')}
        cancelButtonText={t('system.launcher.removeConfirmCancel')}
        intent={Intent.DANGER}
        canOutsideClickCancel
        className="bp6-dark"
      >
        <p>
          {tr(t, 'system.projectConfig.field.languageRemoveBody', {
            name: pendingRemove?.id ?? '',
            count: String(pendingRemove?.files.length ?? 0),
            files: (pendingRemove?.files ?? []).join(', '),
          })}
        </p>
      </Alert>
    </div>
  );
}
