import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  CheckSquare,
  File,
  FolderSync,
  Loader2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  syncApi,
  type SyncActionKind,
  type SyncChecklistItem,
  type SyncCompareSummary,
  type SyncProgressEvent,
} from '../../services/phase5Api';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { formatBytes, formatDateTime } from '../../utils/formatters';

export interface SyncChecklistModalProps {
  summary: SyncCompareSummary;
  sessionId: string | null;
  onClose: () => void;
  onExecuted: (count: number) => void;
}

type ChecklistFilter =
  | 'all'
  | 'new_local'
  | 'new_remote'
  | 'updated_local'
  | 'updated_remote'
  | 'obsolete_remote'
  | 'obsolete_local';

interface ActionMeta {
  label: string;
  category: Exclude<ChecklistFilter, 'all'>;
  direction: 'right' | 'left' | 'delete';
  badgeCls: string;
}

const ACTION_META: Record<SyncActionKind, ActionMeta> = {
  upload_new: {
    label: 'New -> Target',
    category: 'new_local',
    direction: 'right',
    badgeCls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  },
  upload_update: {
    label: 'Update -> Target',
    category: 'updated_local',
    direction: 'right',
    badgeCls: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
  download_new: {
    label: 'New -> Local',
    category: 'new_remote',
    direction: 'left',
    badgeCls: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  },
  download_update: {
    label: 'Update -> Local',
    category: 'updated_remote',
    direction: 'left',
    badgeCls: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  },
  update_remote_timestamp: {
    label: 'TS -> Target',
    category: 'updated_local',
    direction: 'right',
    badgeCls: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  },
  update_local_timestamp: {
    label: 'TS -> Local',
    category: 'updated_remote',
    direction: 'left',
    badgeCls: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  },
  delete_remote: {
    label: 'Delete Target',
    category: 'obsolete_remote',
    direction: 'delete',
    badgeCls: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  },
  delete_local: {
    label: 'Delete Local',
    category: 'obsolete_local',
    direction: 'delete',
    badgeCls: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  },
};

function reverseSyncAction(action: SyncActionKind): SyncActionKind {
  switch (action) {
    case 'upload_update':
      return 'download_update';
    case 'download_update':
      return 'upload_update';
    case 'update_remote_timestamp':
      return 'update_local_timestamp';
    case 'update_local_timestamp':
      return 'update_remote_timestamp';
    default:
      return action;
  }
}

function parentDirFromRel(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '.';
}

export function SyncChecklistModal({
  summary,
  sessionId,
  onClose,
  onExecuted,
}: SyncChecklistModalProps) {
  const { theme } = useWorkspaceStore();
  const isDark = theme === 'dark';

  const [items, setItems] = useState<SyncChecklistItem[]>(summary.items);
  const [filterKind, setFilterKind] = useState<ChecklistFilter>('all');
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(summary.items);
    setFilterKind('all');
    setError(null);
    setProgress(null);
  }, [summary]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void syncApi
      .onSyncProgress((ev) => {
        if (!cancelled) setProgress(ev);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const visibleItems = useMemo(() => {
    if (filterKind === 'all') return items;
    return items.filter((item) => ACTION_META[item.action].category === filterKind);
  }, [items, filterKind]);

  const checkedCount = useMemo(
    () => items.filter((item) => item.checked).length,
    [items],
  );

  const toggleItemChecked = (id: string) => {
    if (executing) return;
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item)),
    );
  };

  const toggleReverseItem = (id: string) => {
    if (executing) return;
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, action: reverseSyncAction(item.action) } : item,
      ),
    );
  };

  const setAllVisibleChecked = (checked: boolean) => {
    if (executing) return;
    const visibleIds = new Set(visibleItems.map((i) => i.id));
    setItems((prev) =>
      prev.map((item) => (visibleIds.has(item.id) ? { ...item, checked } : item)),
    );
  };

  const handleReverseChecked = () => {
    if (executing) return;
    const visibleIds = new Set(visibleItems.map((i) => i.id));
    setItems((prev) =>
      prev.map((item) =>
        item.checked && visibleIds.has(item.id)
          ? { ...item, action: reverseSyncAction(item.action) }
          : item,
      ),
    );
  };

  const handleExecute = async () => {
    if (executing || checkedCount === 0) return;
    setExecuting(true);
    setError(null);
    setProgress({ completed: 0, total: checkedCount, currentPath: '' });
    try {
      const executed = await syncApi.executeChecklist({
        sessionId,
        localDir: summary.localDir,
        remoteDir: summary.remoteDir,
        targetIsRemote: summary.targetIsRemote,
        items,
      });
      onExecuted(executed);
    } catch (err) {
      setError(String(err));
      setExecuting(false);
    }
  };

  const filterBadgeCls = (active: boolean) =>
    `px-2 py-0.5 rounded border text-[10px] font-medium transition-colors cursor-pointer ${
      active
        ? isDark
          ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
          : 'bg-emerald-50 border-emerald-400 text-emerald-700'
        : isDark
          ? 'bg-[#202022] border-[#3c3c3f] text-[#b4b4b4] hover:text-white'
          : 'bg-slate-100 border-slate-300 text-slate-600 hover:text-slate-900'
    }`;

  const filterButtons: { key: ChecklistFilter; label: string; count: number }[] = [
    { key: 'all', label: 'Total', count: items.length },
    { key: 'new_local', label: 'New local', count: summary.newLocalCount },
    { key: 'new_remote', label: 'New target', count: summary.newRemoteCount },
    { key: 'updated_local', label: 'Updated local', count: summary.updatedLocalCount },
    { key: 'updated_remote', label: 'Updated target', count: summary.updatedRemoteCount },
    { key: 'obsolete_remote', label: 'Obsolete target', count: summary.obsoleteRemoteCount },
    { key: 'obsolete_local', label: 'Obsolete local', count: summary.obsoleteLocalCount },
  ];

  const targetLabel = summary.targetIsRemote ? 'Remote' : 'Target Local';
  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !executing) onClose();
      }}
    >
      <div
        className={`w-full max-w-5xl max-h-[88vh] flex flex-col rounded-lg border shadow-2xl overflow-hidden text-xs ${
          isDark
            ? 'bg-[#252526] border-[#3f3f46] text-[#d4d4d4]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b font-semibold shrink-0 ${
            isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <FolderSync className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate">
              Synchronization Checklist — {checkedCount}/{items.length} selected
            </span>
          </div>
          <button
            type="button"
            disabled={executing}
            onClick={onClose}
            className="p-0.5 rounded opacity-70 hover:opacity-100 disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className={`px-4 py-2 border-b flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0 ${
            isDark ? 'bg-[#202022] border-[#333337]' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex flex-wrap items-center gap-3 font-mono min-w-0">
            <span className="truncate max-w-[340px]" title={summary.localDir}>
              <strong className="font-sans opacity-70 mr-1">Local:</strong>
              {summary.localDir}
            </span>
            <span className="opacity-40">&harr;</span>
            <span className="truncate max-w-[340px]" title={summary.remoteDir}>
              <strong className="font-sans opacity-70 mr-1">{targetLabel}:</strong>
              {summary.remoteDir}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={executing || visibleItems.length === 0}
              onClick={() => setAllVisibleChecked(true)}
              className={`px-2.5 py-1 rounded border text-[11px] inline-flex items-center gap-1 ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                  : 'border-slate-300 hover:bg-slate-200 disabled:opacity-40'
              }`}
            >
              <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
              Check All
            </button>
            <button
              type="button"
              disabled={executing || visibleItems.length === 0}
              onClick={() => setAllVisibleChecked(false)}
              className={`px-2.5 py-1 rounded border text-[11px] inline-flex items-center gap-1 ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                  : 'border-slate-300 hover:bg-slate-200 disabled:opacity-40'
              }`}
            >
              <Square className="w-3.5 h-3.5 opacity-70" />
              Uncheck All
            </button>
            <button
              type="button"
              disabled={executing || checkedCount === 0}
              onClick={handleReverseChecked}
              title="Reverse upload/download direction on checked bidirectional items"
              className={`px-2.5 py-1 rounded border text-[11px] inline-flex items-center gap-1 ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                  : 'border-slate-300 hover:bg-slate-200 disabled:opacity-40'
              }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5 text-amber-400" />
              Reverse Direction
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-[260px] overflow-auto">
          {visibleItems.length === 0 ? (
            <div className="h-52 flex items-center justify-center opacity-60 text-xs">
              {items.length === 0
                ? 'Directories are synchronized — no differences found.'
                : 'No checklist entries match the active status filter.'}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-[11px]">
              <thead
                className={`sticky top-0 z-10 border-b ${
                  isDark
                    ? 'bg-[#2d2d30] border-[#3f3f46] text-[#cccccc]'
                    : 'bg-slate-100 border-slate-200 text-slate-700'
                }`}
              >
                <tr>
                  <th className="w-9 px-2.5 py-1.5 text-center">Use</th>
                  <th className="px-2.5 py-1.5">Name / Subdir</th>
                  <th className="px-2.5 py-1.5">Local Size / Modified</th>
                  <th className="w-36 px-2.5 py-1.5 text-center">Direction / Action</th>
                  <th className="px-2.5 py-1.5">{targetLabel} Size / Modified</th>
                </tr>
              </thead>
              <tbody className={isDark ? 'divide-y divide-[#303034]' : 'divide-y divide-slate-200'}>
                {visibleItems.map((item) => {
                  const meta = ACTION_META[item.action];
                  const subdir = parentDirFromRel(item.relativePath);
                  const canReverse = reverseSyncAction(item.action) !== item.action;
                  return (
                    <tr
                      key={item.id}
                      onClick={() => toggleItemChecked(item.id)}
                      className={`cursor-pointer ${
                        item.checked
                          ? isDark
                            ? 'hover:bg-[#2a2d2e]'
                            : 'hover:bg-slate-50'
                          : isDark
                            ? 'opacity-50 hover:bg-[#2a2d2e]'
                            : 'opacity-50 hover:bg-slate-50'
                      }`}
                    >
                      <td className="px-2.5 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={item.checked}
                          disabled={executing}
                          onChange={() => toggleItemChecked(item.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5 font-medium">
                          <File className="w-3.5 h-3.5 opacity-70 shrink-0" />
                          <span className="truncate max-w-[240px]" title={item.relativePath}>
                            {item.name}
                          </span>
                        </div>
                        {subdir !== '.' && (
                          <div className="text-[10px] font-mono opacity-60 pl-5 truncate max-w-[240px]">
                            {subdir}
                          </div>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px]">
                        {item.localSize !== null ? (
                          <div>
                            <div>{formatBytes(item.localSize)}</div>
                            <div className="opacity-65">{formatDateTime(item.localMtimeMs)}</div>
                          </div>
                        ) : (
                          <span className="opacity-40">&mdash;</span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <button
                          type="button"
                          disabled={!canReverse || executing}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canReverse) toggleReverseItem(item.id);
                          }}
                          title={
                            canReverse
                              ? 'Click to reverse sync direction for this file'
                              : meta.label
                          }
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium ${meta.badgeCls} ${
                            canReverse ? 'hover:brightness-125' : 'cursor-default'
                          }`}
                        >
                          {meta.direction === 'right' && <ArrowRight className="w-3 h-3" />}
                          {meta.direction === 'left' && <ArrowLeft className="w-3 h-3" />}
                          {meta.direction === 'delete' && <Trash2 className="w-3 h-3" />}
                          <span>{meta.label}</span>
                        </button>
                      </td>
                      <td className="px-2.5 py-1.5 font-mono text-[10px]">
                        {item.remoteSize !== null ? (
                          <div>
                            <div>{formatBytes(item.remoteSize)}</div>
                            <div className="opacity-65">{formatDateTime(item.remoteMtimeMs)}</div>
                          </div>
                        ) : (
                          <span className="opacity-40">&mdash;</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {executing && progress && (
          <div
            className={`px-4 py-2 border-t text-[11px] shrink-0 ${
              isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="truncate font-mono opacity-80">
                {progress.currentPath || 'Synchronizing...'}
              </span>
              <span className="font-mono">
                {progress.completed} / {progress.total} ({progressPct}%)
              </span>
            </div>
            <div className="h-1.5 w-full rounded bg-slate-700/40 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 py-1.5 bg-rose-500/15 border-t border-rose-500/30 text-rose-400 text-[11px] shrink-0">
            {error}
          </div>
        )}

        <div
          className={`px-4 py-2 border-t flex flex-wrap items-center justify-between gap-2 shrink-0 ${
            isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {filterButtons.map((btn) => (
              <button
                key={btn.key}
                type="button"
                onClick={() =>
                  setFilterKind((prev) => (prev === btn.key ? 'all' : btn.key))
                }
                className={filterBadgeCls(filterKind === btn.key)}
              >
                {btn.label}: {btn.count}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={executing}
              onClick={onClose}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                  : 'border-slate-300 hover:bg-slate-200 disabled:opacity-40'
              }`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={executing || checkedCount === 0}
              onClick={() => void handleExecute()}
              className="px-3.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              {executing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Synchronizing...
                </>
              ) : (
                <>
                  <FolderSync className="w-3.5 h-3.5" />
                  OK ({checkedCount})
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
