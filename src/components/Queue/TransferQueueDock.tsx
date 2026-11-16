import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { translate, type TranslationKey } from '../../i18n';
import { transferApi, type TransferItem } from '../../services/transferApi';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import {
  formatBytes,
  formatDateTime,
  formatDurationSec,
  formatSpeedBps,
} from '../../utils/formatters';

function statusColorClass(status: TransferItem['status']): string {
  switch (status) {
    case 'running':
      return 'text-[#4da3ff]';
    case 'completed':
      return 'text-emerald-400';
    case 'paused':
      return 'text-amber-400';
    case 'conflict':
      return 'text-amber-300';
    case 'failed':
      return 'text-red-400';
    case 'skipped':
    case 'cancelled':
      return 'text-slate-400';
    default:
      return 'text-sky-300';
  }
}

export function TransferQueueDock() {
  const {
    theme,
    locale,
    showQueueDock,
    queueHeight,
    queueItems,
    transferSnapshot,
    clearQueueLogs,
  } = useWorkspaceStore();
  const t = (key: TranslationKey) => translate(locale, key);

  const [dockTab, setDockTab] = useState<'queue' | 'log'>('queue');

  const xferItems = transferSnapshot?.items ?? [];
  const activeCount = transferSnapshot?.activeCount ?? 0;
  const queuedCount = transferSnapshot?.queuedCount ?? 0;
  const maxConcurrent = transferSnapshot?.maxConcurrent ?? 3;
  const globalLimit = transferSnapshot?.globalSpeedLimitKbps ?? 0;
  const totalSpeedBps = transferSnapshot?.totalSpeedBps ?? 0;

  useEffect(() => {
    if (activeCount > 0 || queuedCount > 0) {
      setDockTab('queue');
    }
  }, [activeCount, queuedCount]);

  if (!showQueueDock) return null;

  const isDark = theme === 'dark';

  const tabBtnCls = (active: boolean) =>
    `px-2.5 h-full text-[11px] font-medium border-r transition-colors ${
      isDark ? 'border-[#333333]' : 'border-slate-300'
    } ${
      active
        ? isDark
          ? 'bg-[#1e1e1e] text-white'
          : 'bg-white text-slate-900'
        : isDark
        ? 'text-[#9e9e9e] hover:text-white'
        : 'text-slate-600 hover:text-slate-900'
    }`;

  const smallBtnCls = `inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
    isDark ? 'hover:bg-[#333333] text-[#cccccc]' : 'hover:bg-slate-200 text-slate-700'
  }`;

  return (
    <section
      style={{ height: `${queueHeight}px` }}
      className={`shrink-0 flex flex-col border-t ${
        isDark
          ? 'bg-[#1e1e1e] border-[#333333] text-[#e0e0e0]'
          : 'bg-white border-slate-300 text-slate-800'
      }`}
    >
      {/* Header Bar */}
      <div
        className={`flex items-center justify-between h-7 text-[11px] border-b shrink-0 pr-2 ${
          isDark
            ? 'bg-[#252526] border-[#333333] text-[#dcdcdc]'
            : 'bg-slate-100 border-slate-200 text-slate-700'
        }`}
      >
        <div className="flex items-center h-full">
          <button
            type="button"
            onClick={() => setDockTab('queue')}
            className={tabBtnCls(dockTab === 'queue')}
          >
            {t('queue.tabQueue')} ({xferItems.length})
          </button>
          <button
            type="button"
            onClick={() => setDockTab('log')}
            className={tabBtnCls(dockTab === 'log')}
          >
            {t('queue.tabLog')} ({queueItems.length})
          </button>
          {totalSpeedBps > 0 && (
            <span className="ml-2 font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#1e4b85]/50 text-[#4da3ff]">
              {formatSpeedBps(totalSpeedBps)} • {activeCount} {t('queue.active')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {dockTab === 'queue' ? (
            <>
              <label className="text-[10px] opacity-75">{t('queue.workers')}</label>
              <select
                aria-label="Max concurrent transfers"
                value={maxConcurrent}
                onChange={(e) =>
                  void transferApi.updateSettings(Number(e.target.value), null)
                }
                className={`h-5 px-1 border text-[10px] outline-none ${
                  isDark
                    ? 'bg-[#1b1b1c] border-[#3f3f3f] text-[#dcdcdc]'
                    : 'bg-white border-slate-300 text-slate-800'
                }`}
              >
                {[1, 2, 3, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>

              <label className="text-[10px] opacity-75 ml-1">{t('queue.limit')}</label>
              <select
                aria-label="Global speed limit KB/s"
                value={globalLimit}
                onChange={(e) =>
                  void transferApi.updateSettings(null, Number(e.target.value))
                }
                className={`h-5 px-1 border text-[10px] outline-none ${
                  isDark
                    ? 'bg-[#1b1b1c] border-[#3f3f3f] text-[#dcdcdc]'
                    : 'bg-white border-slate-300 text-slate-800'
                }`}
              >
                <option value={0}>{t('queue.unlimited')}</option>
                <option value={1024}>1024 KB/s</option>
                <option value={512}>512 KB/s</option>
                <option value={256}>256 KB/s</option>
                <option value={128}>128 KB/s</option>
                <option value={64}>64 KB/s</option>
              </select>

              {xferItems.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => void transferApi.controlAll('pause_all')}
                    className={smallBtnCls}
                    title={t('queue.pause')}
                  >
                    <Pause className="w-3 h-3 text-amber-400" />
                    {t('queue.pause')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void transferApi.controlAll('resume_all')}
                    className={smallBtnCls}
                    title={t('queue.resume')}
                  >
                    <Play className="w-3 h-3 text-emerald-400" />
                    {t('queue.resume')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void transferApi.controlAll('cancel_all')}
                    className={smallBtnCls}
                    title={t('queue.cancel')}
                  >
                    <Square className="w-3 h-3 text-red-400" />
                    {t('queue.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void transferApi.controlAll('clear_finished')}
                    className={smallBtnCls}
                    title={t('queue.clearDone')}
                  >
                    <Trash2 className="w-3 h-3" />
                    {t('queue.clearDone')}
                  </button>
                </>
              )}
            </>
          ) : (
            queueItems.length > 0 && (
              <button
                type="button"
                onClick={clearQueueLogs}
                className={smallBtnCls}
              >
                <Trash2 className="w-3 h-3" />
                {t('queue.clear')}
              </button>
            )
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto scpcraft-scroll text-xs">
        {dockTab === 'queue' ? (
          xferItems.length === 0 ? (
            <div
              className={`h-full flex items-center justify-center text-xs ${
                isDark ? 'text-[#777777]' : 'text-slate-400'
              }`}
            >
              {t('queue.empty')}
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead
                className={`sticky top-0 text-[11px] ${
                  isDark ? 'bg-[#252526] text-[#9e9e9e]' : 'bg-slate-50 text-slate-500'
                }`}
              >
                <tr>
                  <th className="py-1 px-2 font-medium w-24">{t('queue.colStatus')}</th>
                  <th className="py-1 px-2 font-medium w-44">{t('queue.colFile')}</th>
                  <th className="py-1 px-2 font-medium">{t('queue.colTarget')}</th>
                  <th className="py-1 px-2 font-medium w-48">{t('queue.colProgress')}</th>
                  <th className="py-1 px-2 font-medium w-32">{t('queue.colSpeed')}</th>
                  <th className="py-1 px-2 font-medium w-24 text-right">{t('queue.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {xferItems.map((it) => {
                  const pct =
                    it.totalBytes > 0
                      ? Math.min(100, Math.round((it.transferredBytes / it.totalBytes) * 100))
                      : it.status === 'completed'
                      ? 100
                      : 0;
                  const canPause = it.status === 'running' || it.status === 'queued';
                  const canResume = it.status === 'paused';
                  const canRetry =
                    it.status === 'failed' ||
                    it.status === 'cancelled' ||
                    it.status === 'skipped';
                  const isTerminal =
                    it.status === 'completed' ||
                    it.status === 'failed' ||
                    it.status === 'cancelled' ||
                    it.status === 'skipped';

                  return (
                    <tr
                      key={it.id}
                      title={it.error ?? undefined}
                      className={`border-t text-[11px] ${
                        isDark
                          ? 'border-[#2d2d2d] hover:bg-[#2a2d2e]'
                          : 'border-slate-100 hover:bg-slate-50'
                      }`}
                    >
                      <td className={`py-1 px-2 font-mono uppercase ${statusColorClass(it.status)}`}>
                        <span>{it.status}</span>
                        {it.resumedFromBytes > 0 && (
                          <span className="ml-1 text-[9px] px-1 rounded bg-amber-500/20 text-amber-300">
                            RESUMED
                          </span>
                        )}
                      </td>
                      <td className="py-1 px-2 truncate max-w-[180px]" title={it.sourcePath}>
                        <span className="opacity-65 mr-1 uppercase text-[10px]">
                          [{it.direction === 'upload' ? 'UP' : it.direction === 'download' ? 'DL' : 'CP'}]
                        </span>
                        {it.fileName}
                      </td>
                      <td className="py-1 px-2 truncate max-w-[220px] font-mono" title={it.targetPath}>
                        {it.targetPath}
                      </td>
                      <td className="py-1 px-2">
                        <div className="flex items-center gap-1.5">
                          <div className={`flex-1 h-2 rounded-sm overflow-hidden ${isDark ? 'bg-[#141414]' : 'bg-slate-200'}`}>
                            <div
                              style={{ width: `${pct}%` }}
                              className={`h-full transition-all duration-150 ${
                                it.status === 'failed'
                                  ? 'bg-red-500'
                                  : it.status === 'completed'
                                  ? 'bg-emerald-500'
                                  : 'bg-[#3b82f6]'
                              }`}
                            />
                          </div>
                          <span className="font-mono text-[10px] w-9 text-right">{pct}%</span>
                        </div>
                        <div className="text-[10px] opacity-65 font-mono">
                          {formatBytes(it.transferredBytes)} / {formatBytes(it.totalBytes)}
                        </div>
                      </td>
                      <td className="py-1 px-2 font-mono text-[10px]">
                        {it.status === 'running' ? (
                          <span>
                            {formatSpeedBps(it.speedBps)} • {formatDurationSec(it.etaSeconds)}
                          </span>
                        ) : it.error ? (
                          <span className="text-red-400 truncate block max-w-[130px]">
                            {it.error}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-1 px-2 text-right">
                        <div className="inline-flex items-center gap-0.5">
                          {canPause && (
                            <button
                              type="button"
                              onClick={() => void transferApi.controlItem(it.id, 'pause')}
                              className="p-0.5 rounded hover:bg-black/20 text-amber-400"
                              title="Pause"
                            >
                              <Pause className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canResume && (
                            <button
                              type="button"
                              onClick={() => void transferApi.controlItem(it.id, 'resume')}
                              className="p-0.5 rounded hover:bg-black/20 text-emerald-400"
                              title="Resume"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {it.status === 'running' && (
                            <button
                              type="button"
                              onClick={() => void transferApi.controlItem(it.id, 'skip')}
                              className="p-0.5 rounded hover:bg-black/20 text-sky-400"
                              title="Skip"
                            >
                              <SkipForward className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canRetry && (
                            <button
                              type="button"
                              onClick={() => void transferApi.controlItem(it.id, 'retry')}
                              className="p-0.5 rounded hover:bg-black/20 text-emerald-400"
                              title="Retry / Resume .filepart"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {!isTerminal ? (
                            <button
                              type="button"
                              onClick={() => void transferApi.controlItem(it.id, 'cancel')}
                              className="p-0.5 rounded hover:bg-black/20 text-red-400"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void transferApi.controlItem(it.id, 'remove')}
                              className="p-0.5 rounded hover:bg-black/20 opacity-65 hover:opacity-100"
                              title="Remove from list"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : queueItems.length === 0 ? (
          <div
            className={`h-full flex items-center justify-center text-xs ${
              isDark ? 'text-[#777777]' : 'text-slate-400'
            }`}
          >
            {t('queue.emptyLog')}
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead
              className={`sticky top-0 text-[11px] ${
                isDark ? 'bg-[#252526] text-[#9e9e9e]' : 'bg-slate-50 text-slate-500'
              }`}
            >
              <tr>
                <th className="py-1 px-2 font-medium w-20">{t('queue.logOp')}</th>
                <th className="py-1 px-2 font-medium">{t('queue.logSource')}</th>
                <th className="py-1 px-2 font-medium">{t('queue.logTarget')}</th>
                <th className="py-1 px-2 font-medium">{t('queue.logDetail')}</th>
                <th className="py-1 px-2 font-medium w-36">{t('queue.logTime')}</th>
              </tr>
            </thead>
            <tbody>
              {queueItems.map((q) => (
                <tr
                  key={q.id}
                  className={`border-t text-[11px] ${
                    isDark
                      ? 'border-[#2d2d2d] hover:bg-[#2a2d2e]'
                      : 'border-slate-100 hover:bg-slate-50'
                  }`}
                >
                  <td className="py-1 px-2 flex items-center gap-1 font-mono uppercase">
                    {q.status === 'error' ? (
                      <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                    )}
                    {q.operation}
                  </td>
                  <td className="py-1 px-2 truncate max-w-[220px] font-mono">{q.source}</td>
                  <td className="py-1 px-2 truncate max-w-[220px] font-mono">{q.target}</td>
                  <td className="py-1 px-2 truncate max-w-[260px]">{q.detail}</td>
                  <td className={`py-1 px-2 font-mono ${isDark ? 'text-[#9e9e9e]' : 'text-slate-500'}`}>
                    {formatDateTime(q.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
