import { useEffect, useState } from 'react';
import { CheckSquare, Loader2, Trash2, X } from 'lucide-react';
import { translate } from '../../i18n';
import { cleanupApi, type CleanupDataItem } from '../../services/phase6Api';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { formatBytes } from '../../utils/formatters';

export function CleanupModal() {
  const { theme, locale, activeModal, closeModal, addQueueLog } = useWorkspaceStore();
  const isOpen = activeModal === 'cleanup';
  const isDark = theme === 'dark';

  const [items, setItems] = useState<CleanupDataItem[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadItems = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await cleanupApi.inspect();
      setItems(list);
      setCheckedIds(new Set(list.filter((i) => i.checkedByDefault).map((i) => i.id)));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void loadItems();
  }, [isOpen]);

  if (!isOpen) return null;

  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const toggleItem = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const existingIds = items.filter((i) => i.exists).map((i) => i.id);
    if (existingIds.every((id) => checkedIds.has(id))) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(existingIds));
    }
  };

  const handleClean = async () => {
    if (checkedIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const removed = await cleanupApi.execute(Array.from(checkedIds));
      addQueueLog({
        operation: 'delete',
        source: `${removed} app data store(s)`,
        target: 'Local Cleanup',
        status: 'done',
        detail: `Cleaned ${removed} selected application data store(s).`,
      });
      await loadItems();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) closeModal();
      }}
    >
      <div
        className={`w-full max-w-2xl rounded-lg border shadow-2xl overflow-hidden text-xs ${
          isDark
            ? 'bg-[#252526] border-[#3f3f46] text-[#d4d4d4]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b font-semibold ${
            isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-rose-400" />
            <span>{t('cleanup.title')}</span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={closeModal}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[11px] opacity-80 leading-relaxed">{t('cleanup.desc')}</p>

          <div
            className={`max-h-72 overflow-auto rounded border ${
              isDark ? 'border-[#333337] bg-[#1e1e1e]' : 'border-slate-200 bg-slate-50'
            }`}
          >
            {loading ? (
              <div className="h-32 flex items-center justify-center gap-2 opacity-70">
                <Loader2 className="w-4 h-4 animate-spin" />
                Inspecting storage...
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-[11px]">
                <thead
                  className={`sticky top-0 border-b ${
                    isDark ? 'bg-[#2d2d30] border-[#3f3f46]' : 'bg-slate-100 border-slate-200'
                  }`}
                >
                  <tr>
                    <th className="w-8 px-2.5 py-1.5 text-center">Use</th>
                    <th className="px-2.5 py-1.5">{t('cleanup.data')}</th>
                    <th className="px-2.5 py-1.5">{t('cleanup.location')}</th>
                  </tr>
                </thead>
                <tbody className={isDark ? 'divide-y divide-[#2d2d30]' : 'divide-y divide-slate-200'}>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => item.exists && toggleItem(item.id)}
                      className={`${
                        item.exists
                          ? isDark
                            ? 'cursor-pointer hover:bg-[#2a2d2e]'
                            : 'cursor-pointer hover:bg-white'
                          : 'opacity-45'
                      }`}
                    >
                      <td className="px-2.5 py-2 text-center align-top">
                        <input
                          type="checkbox"
                          disabled={!item.exists || busy}
                          checked={checkedIds.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2.5 py-2 align-top">
                        <div className="font-medium">{item.label}</div>
                        <div className="text-[10px] opacity-65">{item.description}</div>
                      </td>
                      <td className="px-2.5 py-2 align-top font-mono text-[10px]">
                        <div className="truncate max-w-[270px]" title={item.location}>
                          {item.location}
                        </div>
                        <div className="opacity-70">
                          {item.exists
                            ? `${formatBytes(item.sizeBytes)} (${item.itemCount} item(s))`
                            : 'Not present'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {error && (
            <div className="px-3 py-1.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-400 text-[11px]">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              disabled={busy || items.every((i) => !i.exists)}
              onClick={toggleAll}
              className={`px-3 py-1.5 rounded border text-xs inline-flex items-center gap-1.5 ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                  : 'border-slate-300 hover:bg-slate-100 disabled:opacity-40'
              }`}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {t('cleanup.toggleAll')}
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={closeModal}
                className={`px-3 py-1.5 rounded border text-xs ${
                  isDark
                    ? 'border-[#454545] hover:bg-[#323233]'
                    : 'border-slate-300 hover:bg-slate-100'
                }`}
              >
                {t('cleanup.close')}
              </button>
              <button
                type="button"
                disabled={busy || checkedIds.size === 0}
                onClick={() => void handleClean()}
                className="px-3.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {t('cleanup.cleanSelected')} ({checkedIds.size})
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
