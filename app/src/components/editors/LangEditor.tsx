/**
 * LangEditor —— 语言文件（.lang）编辑器，properties 格式（a.b.c.d = 翻译文本）。
 *
 * 链路（与 ProjectConfigEditor 同构）：
 * - 资源树点击 .lang → system.resource:open → AppShell 匹配资源类型（system.lang）
 *   → WorkspaceTabs 分派到本组件（标签 type = system.lang）
 * - 数据：挂载时 core.project.readFile(path) 读磁盘文本；解析为 key/value 行
 * - 编辑：本地 state 维护行（key + value），添加/删除/编辑
 * - 保存：序列化回 properties 文本 → core.project.writeFile(path, text) 写盘
 *   → 成功后 pushSnapshot 记历史（供撤销/重做/回退）
 * - 历史：模块级权威栈（path → 快照栈 + 基线），注册 system.history:undo/redo/seek
 *   监听（按 path 过滤），还原自身历史快照（写回文件），与 projectConfigHistory
 *   的 project.json 专用 handler 并行、path 互斥。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon, InputGroup, Text } from '@blueprintjs/core';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import {
  HISTORY_UNDO_COMMAND,
  HISTORY_REDO_COMMAND,
  HISTORY_SEEK_COMMAND,
} from '../../core/history/historyModule';
import type { HistoryApi } from '../../core/history/historyModule';

/** 语言条目：key（翻译键）+ value（翻译文本） */
interface LangEntry {
  key: string;
  value: string;
}

interface LangEditorProps {
  /** 标签的 path（.lang 文件的虚拟路径，相对项目根） */
  path?: string;
}

/** 解析 properties 文本 → 条目列表（跳过注释/空行） */
function parseLangText(text: string): LangEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: LangEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) entries.push({ key, value });
  }
  return entries;
}

/** 序列化条目列表 → properties 文本（key = value 换行） */
function serializeLang(entries: LangEntry[]): string {
  return entries.map((e) => `${e.key} = ${e.value}`).join('\n');
}

/* ---------------- 模块级历史权威（path → 快照栈 + 基线，会话级） ---------------- */

/** 历史快照内容：条目列表（undo/redo/seek 还原用） */
type LangSnapshot = LangEntry[];

interface LangHistoryItem {
  id: string;
  label: string;
  timestamp: string;
  snapshot: LangSnapshot;
}

interface LangHistoryStack {
  items: LangHistoryItem[];
  currentIndex: number;
}

const langStacks = new Map<string, LangHistoryStack>();
const langBaselines = new Map<string, LangSnapshot>();
let langIdSeed = 0;

/**
 * 模块级"历史还原"监听器：path → 还原回调。
 * 编辑器组件挂载时注册（把 setEntries + 写盘闭包交进来），卸载时清除。
 * 历史命令（undo/redo/seek）触发时，registerLangHistory 不直接写文件，
 * 而是调用此 listener，由编辑器（权威）更新自身 state 并写盘——
 * 这样编辑器 UI 与磁盘始终保持一致，避免"历史写了文件但 UI 没刷新"。
 */
const langRestoreListeners = new Map<string, (snapshot: LangSnapshot) => void>();

function setLangRestoreListener(path: string, fn: ((snapshot: LangSnapshot) => void) | undefined): void {
  if (fn) langRestoreListeners.set(path, fn);
  else langRestoreListeners.delete(path);
}

function nextLangItemId(): string {
  langIdSeed += 1;
  return `lang${langIdSeed}`;
}

function ensureLangStack(path: string): LangHistoryStack {
  let stack = langStacks.get(path);
  if (!stack) {
    stack = { items: [], currentIndex: -1 };
    langStacks.set(path, stack);
  }
  return stack;
}

/** 把 lang 历史同步到框架镜像 */
function syncLangToFramework(history: HistoryApi | undefined, path: string, stack: LangHistoryStack): void {
  const items = stack.items.map((s) => ({ id: s.id, label: s.label, timestamp: s.timestamp }));
  history?.syncStack(path, items, stack.currentIndex);
}

/** 记录初始基线（首次加载时调用；已存在则不覆盖） */
function recordLangBaseline(path: string, snapshot: LangSnapshot): void {
  if (!langBaselines.has(path)) {
    langBaselines.set(path, snapshot);
  }
}

/** 保存成功后被调用：push 一条历史项（截断 redo 分支 + 指针移末尾 + 同步框架） */
function pushLangSnapshot(path: string, snapshot: LangSnapshot, history: HistoryApi | undefined, label: string): void {
  const stack = ensureLangStack(path);
  const item: LangHistoryItem = {
    id: nextLangItemId(),
    label,
    timestamp: new Date().toISOString(),
    snapshot: snapshot.map((e) => ({ ...e })),
  };
  stack.items = stack.items.slice(0, stack.currentIndex + 1);
  stack.items.push(item);
  stack.currentIndex = stack.items.length - 1;
  langStacks.set(path, stack);
  syncLangToFramework(history, path, stack);
}

/** 读取某文件历史栈（编辑器挂载时初始化展示用） */
export function getLangHistory(path: string): LangHistoryStack | undefined {
  return langStacks.get(path);
}

/** 模块级注册历史命令监听（systemPlugin postInit 调用；与 projectConfigHistory 并行，path 互斥） */
export function registerLangHistory(
  commands: { onCommand: (name: string, handler: (args: unknown) => void | Promise<void>) => () => void },
  history: HistoryApi | undefined,
): () => void {
  /** 解析目标路径：显式 path 优先，缺省用当前活动编辑器路径 */
  const resolvePath = (args: unknown): string | undefined => {
    const { path } = (args ?? {}) as { path?: string };
    return path || history?.getActivePath();
  };

  /**
   * 把某文件状态还原到指定历史项（或基线）：调用编辑器实例注册的还原回调。
   * 编辑器是权威——它收到 snapshot 后更新自身 entries state + 写盘，
   * 写盘成功后再 pushSnapshot 同步历史栈给框架（与正常编辑同一链路）。
   * 这样历史面板→编辑器→磁盘→历史面板形成闭环，UI 与磁盘始终一致。
   */
  const applyLangHistory = (path: string, itemId?: string) => {
    const stack = langStacks.get(path);
    if (!stack) return;
    const targetId = itemId ?? stack.items[stack.currentIndex]?.id;
    const snapshot = targetId
      ? stack.items.find((s) => s.id === targetId)?.snapshot
      : langBaselines.get(path);
    if (!snapshot) return;
    const listener = langRestoreListeners.get(path);
    if (!listener) {
      console.warn('[lang] 历史还原失败：未找到编辑器实例（可能未挂载）', path);
      return;
    }
    listener(snapshot);
  };

  const unsubUndo = commands.onCommand(HISTORY_UNDO_COMMAND, (args) => {
    const path = resolvePath(args);
    if (!path) return;
    const stack = langStacks.get(path);
    if (!stack || stack.currentIndex < 0) return;
    stack.currentIndex -= 1;
    langStacks.set(path, stack);
    syncLangToFramework(history, path, stack);
    applyLangHistory(path);
  });
  const unsubRedo = commands.onCommand(HISTORY_REDO_COMMAND, (args) => {
    const path = resolvePath(args);
    if (!path) return;
    const stack = langStacks.get(path);
    if (!stack || stack.currentIndex >= stack.items.length - 1) return;
    stack.currentIndex += 1;
    langStacks.set(path, stack);
    syncLangToFramework(history, path, stack);
    applyLangHistory(path);
  });
  const unsubSeek = commands.onCommand(HISTORY_SEEK_COMMAND, (args) => {
    const { itemId } = (args ?? {}) as { itemId?: string };
    const path = resolvePath(args);
    if (!path || !itemId) return;
    const stack = langStacks.get(path);
    if (!stack) return;
    const idx = stack.items.findIndex((s) => s.id === itemId);
    if (idx < 0) return;
    stack.currentIndex = idx;
    langStacks.set(path, stack);
    syncLangToFramework(history, path, stack);
    applyLangHistory(path, itemId);
  });

  return () => {
    unsubUndo();
    unsubRedo();
    unsubSeek();
  };
}

/* ---------------- 编辑器组件 ---------------- */

export function LangEditor({ path }: LangEditorProps) {
  const core = useCore();
  const { t } = useI18n();
  /** 已落盘权威条目（每次写盘后更新；编辑态用 draft 暂存，确认时才合并） */
  const [entries, setEntries] = useState<LangEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string>();
  const [error, setError] = useState<string>();
  /** 当前编辑行索引（null=无编辑态）；进入编辑态时用 draft 暂存 key/value */
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  /** 编辑草稿（仅在 editingIdx !== null 时有意义） */
  const [draft, setDraft] = useState<LangEntry>({ key: '', value: '' });
  /** 编辑态 key 输入框自动聚焦用 */
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  // 挂载：读取文件 → 解析 + 记录基线 + 同步历史栈到框架
  useEffect(() => {
    if (!core || !path) return;
    void core.project
      .readFile(path)
      .then(({ content }) => {
        const parsed = parseLangText(content);
        setEntries(parsed);
        setLoaded(true);
        setError(undefined);
        recordLangBaseline(path, parsed);
        const stack = getLangHistory(path);
        syncLangToFramework(core.history, path, stack ?? ensureLangStack(path));
      })
      .catch((err) => {
        console.error('[lang] 读取语言文件失败:', err);
        setError(String(err));
        setLoaded(true);
      });
  }, [core, path]);

  /** 写盘 + push 历史（自动保存：仅确认编辑/删除时调用；label 描述本次操作） */
  const persist = useCallback(
    (next: LangEntry[], label: string) => {
      if (!core || !path) return;
      setSaving(true);
      setError(undefined);
      void core.project
        .writeFile(path, serializeLang(next))
        .then(() => {
          setSaving(false);
          setSaveMsg('saved');
          setTimeout(() => setSaveMsg(undefined), 1500);
          pushLangSnapshot(path, next, core.history, label);
        })
        .catch((err) => {
          console.error('[lang] 保存语言文件失败:', err);
          setError(String(err));
          setSaving(false);
        });
    },
    [core, path],
  );

  /**
   * 历史还原回调（undo/redo/seek 触发）：
   * 编辑器是权威——收到 snapshot 后更新 entries state 并写盘，
   * 但不 pushSnapshot（历史栈指针已由 registerLangHistory 调整，
   * 这里只需让 UI + 磁盘与历史项对齐）。
   */
  const restoreFromHistory = useCallback(
    (snapshot: LangSnapshot) => {
      if (!core || !path) return;
      // 退出编辑态（避免 draft 残留覆盖还原后的 entries）
      setEditingIdx(null);
      setDraft({ key: '', value: '' });
      setEntries(snapshot.map((e) => ({ ...e })));
      void core.project
        .writeFile(path, serializeLang(snapshot))
        .catch((err) => {
          console.error('[lang] 历史还原写盘失败:', err);
          setError(String(err));
        });
    },
    [core, path],
  );

  // 挂载：注册历史还原 listener（供 registerLangHistory 调用）；卸载时清除
  useEffect(() => {
    if (!path) return;
    setLangRestoreListener(path, restoreFromHistory);
    return () => {
      setLangRestoreListener(path, undefined);
    };
  }, [path, restoreFromHistory]);

  /** 进入编辑态：用当前条目内容初始化 draft，并自动聚焦 key 输入框 */
  const startEdit = useCallback((idx: number) => {
    setEditingIdx(idx);
    setDraft({ ...entries[idx] });
    // 下一帧聚焦（input 还未挂载）
    requestAnimationFrame(() => {
      keyInputRef.current?.focus();
      keyInputRef.current?.select();
    });
  }, [entries]);

  /** 取消编辑：丢弃 draft，回到只读；若取消的是新增空行，一并移除 */
  const cancelEdit = useCallback(() => {
    if (editingIdx !== null) {
      const cur = entries[editingIdx];
      // 新增空行（key/value 均空）取消时直接移除，避免列表残留空行
      if (cur && !cur.key && !cur.value) {
        const idx = editingIdx;
        setEntries((prev) => prev.filter((_, i) => i !== idx));
      }
    }
    setEditingIdx(null);
    setDraft({ key: '', value: '' });
  }, [editingIdx, entries]);

  /** 确认编辑：合并 draft 到 entries 并写盘（自动保存） */
  const confirmEdit = useCallback(() => {
    if (editingIdx === null) return;
    const idx = editingIdx;
    // 草稿 key 去空格；空 key 视为放弃（不写入）
    const trimmedKey = draft.key.trim();
    if (!trimmedKey) {
      // 空 key：若该行是新增的空行，直接移除；否则回到原值
      setEntries((prev) => {
        const cur = prev[idx];
        if (!cur.key && !cur.value) {
          const next = prev.filter((_, i) => i !== idx);
          return next;
        }
        return prev;
      });
      setEditingIdx(null);
      setDraft({ key: '', value: '' });
      return;
    }
    // 区分创建/编辑：原 key 为空 = 新建条目；原 key 非空 = 编辑已有条目
    const isCreate = !entries[idx]?.key;
    const label = isCreate ? `创建 ${trimmedKey}` : `编辑 ${entries[idx]?.key ?? trimmedKey}`;
    // 直接用当前 entries 计算 next（避免依赖 setEntries updater 的副作用——
    // React 18 批处理下 updater 可能延迟执行，导致 Promise.resolve().then() 拿到空数组）
    const next = entries.map((e, i) => (i === idx ? { key: trimmedKey, value: draft.value } : e));
    setEntries(next);
    setEditingIdx(null);
    setDraft({ key: '', value: '' });
    persist(next, label);
  }, [editingIdx, draft, persist, entries]);

  /** 删除条目：直接写盘（自动保存） */
  const removeEntry = useCallback(
    (idx: number) => {
      const removedKey = entries[idx]?.key ?? '';
      const next = entries.filter((_, i) => i !== idx);
      setEntries(next);
      // 若删除的是当前编辑行，取消编辑
      if (editingIdx === idx) {
        setEditingIdx(null);
        setDraft({ key: '', value: '' });
      } else if (editingIdx !== null && editingIdx > idx) {
        // 删除前面的行，编辑索引前移
        setEditingIdx(editingIdx - 1);
      }
      const label = removedKey ? `删除 ${removedKey}` : '删除条目';
      persist(next, label);
    },
    [editingIdx, persist, entries],
  );

  /** 添加条目：追加空行（暂不写盘）+ 立即进入编辑态 */
  const addEntry = useCallback(() => {
    setEntries((prev) => {
      const next = [...prev, { key: '', value: '' }];
      const newIdx = next.length - 1;
      setEditingIdx(newIdx);
      setDraft({ key: '', value: '' });
      // 下一帧聚焦新行的 key 输入
      requestAnimationFrame(() => {
        keyInputRef.current?.focus();
      });
      return next;
    });
  }, []);

  if (!loaded) {
    return (
      <div className="lw-editor-panel">
        <div className="lw-editor-placeholder">
          <Icon icon="globe" size={28} />
          <p>加载中…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lw-lang-editor">
      <div className="lw-lang-toolbar">
        <span className="lw-lang-title">{t('system.lang.title')}</span>
        <span className="lw-lang-format-hint">{t('system.lang.formatHint')}</span>
        <div className="lw-lang-toolbar-spacer" />
        {saveMsg && <span className="lw-lang-save-msg">{t('system.lang.saved')}</span>}
        <Button small icon="add" text={t('system.lang.add')} onClick={addEntry} disabled={saving} />
      </div>
      {error && <div className="lw-lang-error">{error}</div>}
      {entries.length === 0 ? (
        <div className="lw-lang-empty">
          <Icon icon="globe" size={28} />
          <p>{t('system.lang.emptyFileHint')}</p>
        </div>
      ) : (
        <div className="lw-lang-list">
          <div className="lw-lang-row lw-lang-row-header">
            <span className="lw-lang-key-col">{t('system.lang.key')}</span>
            <span className="lw-lang-value-col">{t('system.lang.value')}</span>
            <span className="lw-lang-actions-col" />
          </div>
          {entries.map((entry, idx) => {
            const isEditing = editingIdx === idx;
            return (
              <div className={`lw-lang-row${isEditing ? ' lw-lang-row-editing' : ''}`} key={idx}>
                {isEditing ? (
                  <>
                    <InputGroup
                      className="lw-lang-key-col"
                      inputRef={(el) => { keyInputRef.current = el; }}
                      placeholder="a.b.c.d"
                      value={draft.key}
                      onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void confirmEdit(); }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                      }}
                      spellCheck={false}
                    />
                    <InputGroup
                      className="lw-lang-value-col"
                      placeholder="翻译文本"
                      value={draft.value}
                      onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void confirmEdit(); }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                      }}
                    />
                  </>
                ) : (
                  <>
                    <Text className="lw-lang-key-col lw-lang-key-text" title={entry.key} ellipsize>
                      {entry.key}
                    </Text>
                    <Text className="lw-lang-value-col lw-lang-value-text" title={entry.value} ellipsize>
                      {entry.value}
                    </Text>
                  </>
                )}
                <div className="lw-lang-actions-col">
                  {isEditing ? (
                    <>
                      <Button minimal small icon="cross" title={t('system.lang.cancel')} onClick={cancelEdit} />
                      <Button minimal small icon="tick" intent="primary" title={t('system.lang.confirm')} onClick={() => void confirmEdit()} loading={saving} />
                    </>
                  ) : (
                    <>
                      <Button minimal small icon="edit" title={t('system.lang.edit')} onClick={() => startEdit(idx)} />
                      <Button minimal small icon="trash" intent="danger" title={t('system.lang.remove')} onClick={() => removeEntry(idx)} />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
