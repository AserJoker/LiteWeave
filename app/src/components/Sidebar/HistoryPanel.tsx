/**
 * 历史面板 —— 右侧边栏展示当前活动编辑器对应文件的历史列表。
 *
 * 数据源：core.history（会话级历史表）。只读展示 HistoryItem（label + 时间），
 * 点击某项 → history.seek(path, itemId) 发命令回退到该历史时刻（编辑器订阅后执行）。
 *
 * 当前活动标签路径由 AppShell 广播 system.shell:active-path-changed 事件（载荷 { path? }）
 * 通知；本组件订阅后获取。无活动编辑器 / 无历史时显示空态。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Icon } from '@blueprintjs/core';
import { useCore } from '../../core/coreContext';
import { useI18n } from '../../core/i18n/i18nHooks';
import { ACTIVE_PATH_CHANGED, type HistoryStack } from '../../core/history/historyModule';

/** 相对时间显示：xx 秒/分钟/小时前（会话级历史，时间跨度通常很短） */
function timeAgo(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  return `${Math.floor(diff / 3600000)}h`;
}

export function HistoryPanel() {
  const core = useCore();
  const { t } = useI18n();
  const [activePath, setActivePath] = useState<string | undefined>();
  const [stack, setStack] = useState<HistoryStack | undefined>();

  // 模块级 activePath 初始化（读权威值，不依赖广播时机）+ 订阅路径变更广播
  useEffect(() => {
    if (!core) return;
    const update = (path?: string) => {
      setActivePath(path);
      setStack(path ? core.history.getStack(path) : undefined);
    };
    update(core.history.getActivePath());
    return core.events.subscribe(ACTIVE_PATH_CHANGED, (payload) => {
      update((payload as { path?: string } | undefined)?.path);
    });
  }, [core]);

  // 订阅历史栈变更：路径匹配则刷新列表
  useEffect(() => {
    if (!core || !activePath) return;
    return core.history.subscribe(({ path, stack: next }) => {
      if (path === activePath) {
        setStack(next);
      }
    });
  }, [core, activePath]);

  // 时间戳刷新（列表显示相对时间）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => stack?.items ?? [], [stack]);
  const currentIndex = stack?.currentIndex ?? -1;

  return (
    <div className="lw-history">
      <div className="lw-history-header">
        <span className="lw-history-title">{t('system.history.title')}</span>
        {activePath && <span className="lw-history-path" title={activePath}>{activePath}</span>}
      </div>

      {!activePath ? (
        <div className="lw-history-empty">
          <Icon icon="history" size={28} />
          <p>{t('system.history.emptyNoEditor')}</p>
          <span>{t('system.history.emptyNoEditorHint')}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="lw-history-empty">
          <Icon icon="history" size={28} />
          <p>{t('system.history.empty')}</p>
          <span>{t('system.history.emptyHint')}</span>
        </div>
      ) : (
        <div className="lw-history-list">
          {items.map((item, idx) => {
            const active = idx === currentIndex;
            const isFuture = idx > currentIndex;
            return (
              <button
                key={item.id}
                className={`lw-history-item${active ? ' lw-history-item-active' : ''}`}
                onClick={() => {
                  if (!core || !activePath || active) return;
                  core.history.seek(activePath, item.id);
                }}
                title={item.label}
              >
                <Icon
                  icon={active ? 'locate' : isFuture ? 'undo' : 'history'}
                  size={12}
                />
                <span className="lw-history-item-label">{item.label}</span>
                <span className="lw-history-item-time">{timeAgo(item.timestamp, now)}</span>
                {!active && (
                  <Button
                    minimal
                    small
                    icon="fast-backward"
                    className="lw-history-item-restore"
                    title={t('system.history.restoreHint')}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!core || !activePath) return;
                      core.history.seek(activePath, item.id);
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {activePath && items.length > 0 && (
        <div className="lw-history-footer">
          <Button
            minimal
            small
            icon="cross"
            text={t('system.history.clear')}
            onClick={() => core?.history.clear(activePath)}
            disabled={!core}
          />
        </div>
      )}
    </div>
  );
}
