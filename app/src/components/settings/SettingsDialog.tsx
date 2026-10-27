/**
 * 设置对话框。
 *
 * 布局：顶部全局搜索 + 左侧二级树（大类 / 小类）+ 右侧表单。
 * - 搜索按 大类名 / 小类名 / 字段 label 匹配，过滤左侧树；
 * - 选中某个小类后，右侧用 SchemaForm（Schema 驱动表单引擎）渲染该小类的表单；
 * - 修改即生效：字段变更 → runCommand('system.settings:set', { key: 路径, value })
 *   → 后端持久化 + SSE 推回 → 广播 system.settings:changed → 本组件按 key 判断是否关心 → 拉 cache 值更新界面。
 *
 * 字段路径 = 命名空间.大类id.小类id.字段key（如 system.general.appearance.language）。
 * mock 设置数据为 schema 定义；后续可替换为各模块向 settings 注册器注册的 schema。
 * 命名空间规范：<命名空间>.<大类>.<小类>.<字段>；系统级配置命名空间保留为 system。
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogBody, InputGroup } from '@blueprintjs/core';
import { SchemaForm, type FieldSchema, type FieldValue } from '../../core/schema/schemaForm';
import type { FormStore } from '../../core/schema/formStore';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import {
  SETTINGS_CHANGED,
  SETTINGS_LOADED,
  SETTINGS_SET_COMMAND,
  type SettingsChangedPayload,
  type SettingsApi,
} from '../../core/store/storeModule';

/* ---------------- mock 设置数据 ---------------- */

/** 字段定义：label/helper/options 用 i18n key，控件属性原样保留 */
interface SettingFieldKey {
  /** 字段 key（设置路径的一部分，非 i18n key） */
  key: string
  /** 字段 label 的 i18n key，如 system.settings.field.language */
  labelKey: string
  /** helper 的 i18n key，如 system.settings.field.languageHelper */
  helperKey?: string
  /** select 选项（value 为存储值，labelKey 为显示文案 i18n key） */
  options?: { value: string; labelKey: string }[]
  type?: 'switch'
  placeholder?: string
  min?: number
  max?: number
  step?: number
}

/** 小类（二级节点），对应一页表单 */
export interface SettingItem {
  id: string;
  /** 小类名 i18n key（system.settings.item.<大类id>.<小类id>） */
  titleKey: string;
  /** 表单字段（含 label/helper 的 i18n key） */
  fields: SettingFieldKey[];
}

/** 大类（一级节点），下面挂若干小类 */
export interface SettingSection {
  id: string;
  /** 大类名 i18n key（system.settings.section.<id>） */
  titleKey: string;
  items: SettingItem[];
}

/** 设置数据域命名空间（保留命名空间：系统级） */
export const SETTINGS_NAMESPACE = 'system';

/** 构建 select 字段：label 用 system.settings.field.<key>，option 的 labelKey 需显式给出（存储值与 i18n key 命名可能不同，如 zh-CN vs zh_CN） */
function sel(key: string, options: { value: string; labelKey: string }[]): SettingFieldKey {
  return { key, labelKey: `system.settings.field.${key}`, options }
}

/** 把字段定义（i18n key）解析为 SchemaForm 可渲染的 FieldSchema（labelKey/helperKey 保留 key，渲染时 t 翻译） */
function buildFieldSchemas(item: SettingItem): FieldSchema[] {
  return item.fields.map((f) => {
    const base = {
      key: f.key,
      labelKey: f.labelKey,
      helperKey: f.helperKey,
    }
    if (f.options) {
      return {
        ...base,
        type: 'select' as const,
        options: f.options.map((o) => ({ value: o.value, labelKey: o.labelKey })),
      }
    }
    if (f.type === 'switch') {
      return { ...base, type: 'switch' as const }
    }
    if (f.min !== undefined || f.step !== undefined) {
      return { ...base, type: 'number' as const, placeholder: f.placeholder, min: f.min, max: f.max, step: f.step }
    }
    return { ...base, type: 'text' as const, placeholder: f.placeholder }
  })
}

const SETTINGS: SettingSection[] = [
  {
    id: 'general',
    titleKey: 'system.settings.section.general',
    items: [
      {
        id: 'appearance',
        titleKey: 'system.settings.item.general.appearance',
        fields: [
          { ...sel('language', [{ value: 'zh-CN', labelKey: 'system.settings.option.zh_CN' }, { value: 'en-US', labelKey: 'system.settings.option.en_US' }]), helperKey: 'system.settings.field.languageHelper' },
        ],
      },
    ],
  },
];

/** 表单值：itemId.fieldKey → value */
type FormValue = Record<string, FieldValue>;

/** 字段完整设置路径：命名空间.大类id.小类id.字段key（如 system.general.appearance.language） */
function fieldPath(section: SettingSection, item: SettingItem, fieldKey: string): string {
  return `${SETTINGS_NAMESPACE}.${section.id}.${item.id}.${fieldKey}`;
}

/** 小类唯一键：命名空间.大类id.小类id（如 system.general.behavior；不同大类下小类 id 可重复） */
function itemKey(section: SettingSection, item: SettingItem): string {
  return `${SETTINGS_NAMESPACE}.${section.id}.${item.id}`;
}

/** 从 cache 拉字段当前值（后端持久化的真实值）；未命中返回 undefined */
function cachedValue(settings: SettingsApi | undefined, path: string): FieldValue | undefined {
  const v = settings?.get(path);
  return v === undefined || v === null ? undefined : (v as FieldValue);
}

/* ---------------- 组件 ---------------- */

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const core = useCore();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  // 选中小类：用“命名空间.大类id.小类id”唯一键（不同大类下小类 id 可重复，如 system.general.behavior 与 system.ai.behavior）
  const [selectedKey, setSelectedKey] = useState<string>(itemKey(SETTINGS[0], SETTINGS[0].items[0]));
  // 受控值：初始从后端 cache 拉真实值，未命中用 schema 默认
  // 本地编辑覆盖：只在用户改动后短暂保留，直到后端 SSE 推回确认（system.settings:changed）后清除。
  // 显示值 = 本地编辑 ?? 后端 cache 值（cache 为权威真相）。
  const [localEdit, setLocalEdit] = useState<FormValue>({});
  // lazy 加载：对话框打开时按需拉取后端全量设置到 cache（框架不自动拉，首次打开才触发）
  useEffect(() => {
    if (!core || !isOpen) return;
    void core.settings.ensureLoaded();
  }, [core, isOpen]);

  // 搜索过滤：匹配大类名 / 小类名 / 字段 label（均为翻译后的显示文案）。命中大类则保留整个大类。
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SETTINGS;
    return SETTINGS.map((section) => {
      const sectionMatch = t(section.titleKey).toLowerCase().includes(q);
      const items = sectionMatch
        ? section.items
        : section.items.filter(
            (item) =>
              t(item.titleKey).toLowerCase().includes(q) ||
              item.fields.some((f) => t(f.labelKey).toLowerCase().includes(q)),
          );
      return items.length > 0 ? { ...section, items } : null;
    }).filter((s): s is SettingSection => s !== null);
  }, [query, t]);

  // 从唯一键（命名空间.大类id.小类id）反解当前大类与小类（计算便宜，无需 useMemo）
  const selectedSection = (() => {
    const seg = selectedKey.split('.');
    const sectionId = seg[seg.length - 2];
    return SETTINGS.find((s) => s.id === sectionId);
  })();
  const selectedItem = (() => {
    if (!selectedSection) return undefined;
    const seg = selectedKey.split('.');
    const itemId = seg[seg.length - 1];
    return selectedSection.items.find((i) => i.id === itemId);
  })();

  // 订阅设置变更：后端 SSE 推回确认 → 清除对应字段的本地编辑，显示回到 cache 值。
  // 依赖 selectedKey：切换小类时重新订阅，闭包内始终是最新选中项。
  useEffect(() => {
    if (!core) return;
    return core.events.subscribe(SETTINGS_CHANGED, (payload) => {
      const { key } = payload as SettingsChangedPayload;
      if (!selectedItem || !selectedSection) return;
      for (const field of selectedItem.fields) {
        const fullKey = fieldPath(selectedSection, selectedItem, field.key);
        if (fullKey === key) {
          // 后端已确认该字段值，清除本地编辑，让显示回到 cache（真实值）
          setLocalEdit((prev) => {
            const next = { ...prev };
            delete next[fullKey];
            return next;
          });
        }
      }
    });
  }, [core, selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当前小类对应的 FormStore 适配器（每次 render 直接构造，闭包捕获最新 localEdit）：
  // - get：本地编辑优先，否则从后端 cache 读（权威真相）
  // - set：记录本地编辑（立即反映 UI）+ 发命令到后端（key = 完整设置路径，修改即生效）
  // - subscribe：订阅外部变更（SSE 推回 / 加载完成）→ 触发重渲染 → SchemaForm 重新 get
  const formStore: FormStore | undefined =
    !core || !selectedSection || !selectedItem
      ? undefined
      : {
          get: (key) => {
            const full = fieldPath(selectedSection, selectedItem, key);
            const edit = localEdit[full];
            if (edit !== undefined) return edit as FieldValue | FieldValue[];
            return cachedValue(core.settings, full) as FieldValue | FieldValue[] | undefined;
          },
          set: (key, value) => {
            const full = fieldPath(selectedSection, selectedItem, key);
            setLocalEdit((prev) => ({ ...prev, [full]: value as FieldValue }));
            void core.commands.runCommand(SETTINGS_SET_COMMAND, { key: full, value });
          },
          subscribe: (listener) => {
            const offs = [
              core.events.subscribe(SETTINGS_CHANGED, () => listener()),
              core.events.subscribe(SETTINGS_LOADED, () => listener()),
            ];
            return () => offs.forEach((off) => off());
          },
        };

  // 当前小类字段解析为 FieldSchema（labelKey/helperKey 保留 key，渲染时 t 翻译，随语言切换重算）
  const selectedFields = useMemo(
    () => (selectedItem ? buildFieldSchemas(selectedItem) : []),
    [selectedItem],
  );
  // 包装为 schema 树（field 节点）；useMemo 保持引用稳定，避免 SchemaForm 校验 effect 循环
  const selectedSchema = useMemo(
    () =>
      selectedFields.map((f) => ({
        // 节点稳定 id：命名空间.大类id.小类id.字段key（settings 字段路径，schema 内唯一）
        id: `${SETTINGS_NAMESPACE}.${selectedSection?.id}.${selectedItem?.id}.${f.key}`,
        kind: 'field' as const,
        field: f,
      })),
    [selectedFields, selectedSection, selectedItem],
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('system.settings.title')}
      className="lw-settings-dialog bp6-dark"
      style={{ width: 780, height: 520 }}
    >
      <div className="lw-settings-toolbar">
        <InputGroup
          leftIcon="search"
          placeholder={t('system.settings.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          fill
        />
      </div>
      <DialogBody className="lw-settings-body">
        <nav className="lw-settings-nav">
          {filteredSections.length === 0 && <div className="lw-settings-empty">{t('system.settings.empty')}</div>}
          {filteredSections.map((section) => (
            <div key={section.id} className="lw-settings-section">
              <div className="lw-settings-section-title">{t(section.titleKey)}</div>
              {section.items.map((item) => (
                <div
                  key={itemKey(section, item)}
                  className={itemKey(section, item) === selectedKey ? 'lw-settings-nav-item lw-settings-nav-item-active' : 'lw-settings-nav-item'}
                  onClick={() => setSelectedKey(itemKey(section, item))}
                >
                  {t(item.titleKey)}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="lw-settings-form">
          {selectedItem && selectedSection && (
            <>
              <h3 className="lw-settings-form-title">{t(selectedItem.titleKey)}</h3>
              {/* FormStore 适配器注入：值读写/外部同步走 store，引擎不关心后端细节 */}
              {formStore && <SchemaForm schema={selectedSchema} store={formStore} t={t} renderers={core?.schemaRenderers} />}
            </>
          )}
        </div>
      </DialogBody>
    </Dialog>
  );
}
