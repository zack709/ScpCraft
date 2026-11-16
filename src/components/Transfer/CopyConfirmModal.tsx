import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Download,
  FolderSync,
  Pause,
  Play,
  SkipForward,
  Sliders,
  Upload,
  X,
} from 'lucide-react';
import {
  buildDefaultTransferOptions,
  transferApi,
  type OverwritePolicy,
  type TransferItem,
  type TransferMode,
  type TransferOptions,
} from '../../services/transferApi';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { formatBytes, formatDurationSec, formatSpeedBps } from '../../utils/formatters';

function ForegroundProgressModal() {
  const {
    theme,
    foregroundBatchId,
    transferSnapshot,
    setForegroundBatchId,
    toggleQueueDock,
    showQueueDock,
  } = useWorkspaceStore();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [speedLimit, setSpeedLimit] = useState<number>(
    transferSnapshot?.globalSpeedLimitKbps ?? 0,
  );

  useEffect(() => {
    if (!foregroundBatchId) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [foregroundBatchId]);

  useEffect(() => {
    setSpeedLimit(transferSnapshot?.globalSpeedLimitKbps ?? 0);
  }, [transferSnapshot?.globalSpeedLimitKbps]);

  const batchItems: TransferItem[] = (transferSnapshot?.items ?? []).filter(
    (it) => it.batchId === foregroundBatchId,
  );

  const runningItem =
    batchItems.find((i) => i.status === 'running' || i.status === 'conflict') ??
    batchItems.find((i) => i.status === 'paused') ??
    batchItems.find((i) => i.status === 'queued') ??
    batchItems[batchItems.length - 1];

  const totalBytes = batchItems.reduce((acc, i) => acc + i.totalBytes, 0);
  const doneBytes = batchItems.reduce((acc, i) => acc + i.transferredBytes, 0);
  const completedCount = batchItems.filter((i) => i.status === 'completed').length;
  const failedCount = batchItems.filter((i) => i.status === 'failed').length;
  const activeCount = batchItems.filter(
    (i) =>
      i.status === 'running' ||
      i.status === 'queued' ||
      i.status === 'paused' ||
      i.status === 'conflict',
  ).length;
  const isAllFinished = batchItems.length > 0 && activeCount === 0;
  const anyPaused = batchItems.some((i) => i.status === 'paused');

  // Auto-close foreground modal once batch cleanly completes with zero errors
  useEffect(() => {
    if (!foregroundBatchId || !isAllFinished || failedCount > 0) return;
    const timer = window.setTimeout(() => {
      setForegroundBatchId(null);
    }, 550);
    return () => window.clearTimeout(timer);
  }, [foregroundBatchId, isAllFinished, failedCount, setForegroundBatchId]);

  if (!foregroundBatchId) return null;

  const isDark = theme === 'dark';
  const batchSpeed = batchItems.reduce((acc, i) => acc + i.speedBps, 0);
  const remainingBytes = Math.max(0, totalBytes - doneBytes);
  const batchEta =
    batchSpeed > 0 ? Math.ceil(remainingBytes / batchSpeed) : runningItem?.etaSeconds ?? null;
  const earliestStart = batchItems.reduce<number | null>((min, i) => {
    if (!i.startedAtMs) return min;
    return min === null ? i.startedAtMs : Math.min(min, i.startedAtMs);
  }, null);
  const elapsedSec = earliestStart ? Math.max(0, Math.floor((nowMs - earliestStart) / 1000)) : 0;

  const filePct =
    runningItem && runningItem.totalBytes > 0
      ? Math.min(100, Math.round((runningItem.transferredBytes / runningItem.totalBytes) * 100))
      : isAllFinished
      ? 100
      : 0;
  const totalPct =
    totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : isAllFinished ? 100 : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        className={`w-full max-w-lg rounded border shadow-2xl overflow-hidden text-xs ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2 border-b font-semibold ${
            isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4 text-[#4da3ff]" />
            <span>
              {runningItem?.direction === 'upload'
                ? 'Uploading...'
                : runningItem?.direction === 'download'
                ? 'Downloading...'
                : 'Copying...'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setForegroundBatchId(null)}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
            title="Minimize"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* File & Target paths */}
          <div className="space-y-1 text-[11px]">
            <div className="flex gap-2">
              <span className="w-14 shrink-0 opacity-70">File:</span>
              <span className="font-mono truncate flex-1">
                {runningItem?.sourcePath || 'Preparing transfer...'}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-14 shrink-0 opacity-70">Target:</span>
              <span className="font-mono truncate flex-1">
                {runningItem?.targetPath || '—'}
              </span>
            </div>
          </div>

          {/* Current file progress bar */}
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span>Current file</span>
              <span className="font-mono">{filePct}%</span>
            </div>
            <div className={`h-3 w-full overflow-hidden rounded-sm ${isDark ? 'bg-[#1b1b1c]' : 'bg-slate-200'}`}>
              <div
                style={{ width: `${filePct}%` }}
                className="h-full bg-[#10b981] transition-all duration-150"
              />
            </div>
          </div>

          {/* Total batch progress bar */}
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span>
                Total ({completedCount} / {batchItems.length} file(s)
                {failedCount > 0 ? `, ${failedCount} failed` : ''})
              </span>
              <span className="font-mono">{totalPct}%</span>
            </div>
            <div className={`h-3.5 w-full overflow-hidden rounded-sm ${isDark ? 'bg-[#1b1b1c]' : 'bg-slate-200'}`}>
              <div
                style={{ width: `${totalPct}%` }}
                className={`h-full transition-all duration-150 ${
                  failedCount > 0 ? 'bg-red-500' : 'bg-[#2563eb]'
                }`}
              />
            </div>
          </div>

          {/* Stats Grid (TProgressForm Time left, Elapsed, Bytes, Speed) */}
          <div
            className={`grid grid-cols-2 gap-x-4 gap-y-1 p-2.5 rounded border text-[11px] ${
              isDark ? 'bg-[#1e1e1e] border-[#383838]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex justify-between">
              <span className="opacity-70">Time left:</span>
              <span className="font-mono">{formatDurationSec(batchEta)}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Time elapsed:</span>
              <span className="font-mono">{formatDurationSec(elapsedSec)}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Transferred:</span>
              <span className="font-mono">
                {formatBytes(doneBytes)} / {formatBytes(totalBytes)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Speed:</span>
              <span className="font-mono text-[#4da3ff]">{formatSpeedBps(batchSpeed)}</span>
            </div>
          </div>

          {failedCount > 0 && (
            <div className="p-2 rounded bg-red-500/15 border border-red-500/40 text-red-300 text-[11px]">
              {batchItems.find((i) => i.status === 'failed')?.error || 'One or more transfers failed.'}
            </div>
          )}

          {/* Action toolbar matching TProgressForm */}
          <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] opacity-75">Speed limit:</label>
              <select
                value={speedLimit}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setSpeedLimit(val);
                  void transferApi.updateSettings(null, val);
                }}
                className={`h-7 px-1.5 rounded border text-[11px] outline-none ${
                  isDark
                    ? 'bg-[#1b1b1c] border-[#454545] text-slate-200'
                    : 'bg-white border-slate-300 text-slate-800'
                }`}
              >
                <option value={0}>Unlimited</option>
                <option value={1024}>1024 KB/s</option>
                <option value={512}>512 KB/s</option>
                <option value={256}>256 KB/s</option>
                <option value={128}>128 KB/s</option>
                <option value={64}>64 KB/s</option>
                <option value={32}>32 KB/s</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {!isAllFinished && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void transferApi.controlAll(
                        anyPaused ? 'resume_all' : 'pause_all',
                        foregroundBatchId,
                      )
                    }
                    className={`px-2.5 py-1 rounded border text-[11px] inline-flex items-center gap-1 ${
                      isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    {anyPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                    {anyPaused ? 'Resume' : 'Pause'}
                  </button>
                  {runningItem && runningItem.status === 'running' && (
                    <button
                      type="button"
                      onClick={() => void transferApi.controlItem(runningItem.id, 'skip')}
                      className={`px-2.5 py-1 rounded border text-[11px] inline-flex items-center gap-1 ${
                        isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      <SkipForward className="w-3 h-3" />
                      Skip
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (!showQueueDock) toggleQueueDock();
                      setForegroundBatchId(null);
                    }}
                    className="px-2.5 py-1 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-[11px]"
                  >
                    Proceed in Background
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void transferApi.controlAll('cancel_all', foregroundBatchId);
                      setForegroundBatchId(null);
                    }}
                    className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-[11px]"
                  >
                    Cancel
                  </button>
                </>
              )}
              {isAllFinished && (
                <button
                  type="button"
                  onClick={() => setForegroundBatchId(null)}
                  className="px-3 py-1 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-[11px]"
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CopyConfirmModal() {
  const {
    theme,
    activeModal,
    copyDialogPreset,
    activeTabId,
    transferPreset,
    transferSnapshot,
    closeModal,
    enqueueTransfer,
  } = useWorkspaceStore();

  const [targetDir, setTargetDir] = useState('');
  const [options, setOptions] = useState<TransferOptions>(() =>
    buildDefaultTransferOptions('upload', null, false, 'Default'),
  );
  const [maxConcurrent, setMaxConcurrent] = useState<number>(3);
  const [showSettings, setShowSettings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCopyOrMove = activeModal === 'copy' || activeModal === 'move';

  useEffect(() => {
    if (!isCopyOrMove || !copyDialogPreset) return;
    setError(null);
    setBusy(false);
    setTargetDir(copyDialogPreset.targetDir);
    const sid = copyDialogPreset.direction === 'local_copy' ? null : activeTabId;
    setOptions(
      buildDefaultTransferOptions(
        copyDialogPreset.direction,
        sid,
        copyDialogPreset.isMove,
        transferPreset,
      ),
    );
    setMaxConcurrent(transferSnapshot?.maxConcurrent ?? 3);
  }, [activeModal, copyDialogPreset]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!copyDialogPreset || copyDialogPreset.sources.length === 0) {
      setError('No files selected to transfer.');
      return;
    }
    const cleanTarget = targetDir.trim();
    if (!cleanTarget) {
      setError('Target directory cannot be empty.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await transferApi.updateSettings(maxConcurrent, null);
      const showForeground = !options.backgroundQueue;
      await enqueueTransfer(
        {
          sources: copyDialogPreset.sources,
          targetDir: cleanTarget,
          options,
        },
        showForeground,
      );
      closeModal();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  if (!isCopyOrMove || !copyDialogPreset) {
    return <ForegroundProgressModal />;
  }

  const isDark = theme === 'dark';
  const dirLabel =
    copyDialogPreset.direction === 'upload'
      ? 'Upload (Local -> Remote SFTP)'
      : copyDialogPreset.direction === 'download'
      ? 'Download (Remote SFTP -> Local)'
      : 'Local Transfer (Pane -> Pane)';

  const ActionIcon =
    copyDialogPreset.direction === 'upload'
      ? Upload
      : copyDialogPreset.direction === 'download'
      ? Download
      : FolderSync;

  const titleVerb = copyDialogPreset.isMove
    ? 'Move'
    : copyDialogPreset.direction === 'upload'
    ? 'Upload'
    : copyDialogPreset.direction === 'download'
    ? 'Download'
    : 'Copy';

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1b1b1c] border-[#454545] text-slate-100 focus:border-[#3b82f6]'
      : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
  }`;

  const setTransferMode = (transferMode: TransferMode) =>
    setOptions((prev) => ({ ...prev, transferMode }));

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
      >
        <div
          className={`w-full max-w-xl rounded border shadow-2xl overflow-hidden text-xs ${
            isDark
              ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
              : 'bg-white border-slate-300 text-slate-800'
          }`}
        >
          <div
            className={`flex items-center justify-between px-4 py-2.5 border-b font-semibold ${
              isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-100 border-slate-200'
            }`}
          >
            <div className="flex items-center gap-2">
              <ActionIcon className="w-4 h-4 text-[#4da3ff]" />
              <span>
                {titleVerb} ({copyDialogPreset.sources.length} selected item(s))
              </span>
              <span
                className={`text-[10px] font-normal px-1.5 py-0.5 rounded ${
                  isDark ? 'bg-[#1e4b85]/50 text-sky-200' : 'bg-blue-100 text-blue-800'
                }`}
              >
                {dirLabel}
              </span>
            </div>
            <button type="button" onClick={closeModal} className="p-0.5 rounded opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="p-4 space-y-3">
            {error && (
              <div className="p-2 rounded bg-red-500/20 border border-red-500/40 text-red-300">
                {error}
              </div>
            )}

            <div>
              <label className="block mb-1 font-medium">
                {titleVerb} {copyDialogPreset.sources.length} item(s) to target directory:
              </label>
              <input
                autoFocus
                type="text"
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                className={inputCls}
                required
              />
              <p className="mt-1 text-[11px] opacity-70 font-mono truncate">
                First item: {copyDialogPreset.sources[0] || '—'}
              </p>
            </div>

            {/* Expandable Transfer Settings summary/frame (TCopyDialog -> TCopyParamsFrame) */}
            <div className={`border rounded ${isDark ? 'border-[#3c3c3c]' : 'border-slate-200'}`}>
              <button
                type="button"
                onClick={() => setShowSettings((s) => !s)}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium ${
                  isDark ? 'bg-[#1e1e1e] hover:bg-[#2c2c2d]' : 'bg-slate-50 hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-[#4da3ff]" />
                  Transfer settings ({options.transferMode}, {options.useFilepart ? '.filepart' : 'direct'}, mask: {options.fileMask || '*'})
                </span>
                {showSettings ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>

              {showSettings && (
                <div className="p-3 space-y-3 text-[11px]">
                  <div className="grid grid-cols-2 gap-3">
                    {/* Transfer Mode */}
                    <div className={`p-2 rounded border space-y-1.5 ${isDark ? 'border-[#383838] bg-[#1e1e1e]' : 'border-slate-200 bg-slate-50'}`}>
                      <div className="font-semibold text-[11px]">Transfer mode</div>
                      {(['binary', 'text', 'automatic'] as TransferMode[]).map((m) => (
                        <label key={m} className="flex items-center gap-2 cursor-pointer capitalize">
                          <input
                            type="radio"
                            name="transfer-mode"
                            checked={options.transferMode === m}
                            onChange={() => setTransferMode(m)}
                          />
                          <span>
                            {m === 'binary'
                              ? 'Binary (archives, images, raw)'
                              : m === 'text'
                              ? 'Text (CRLF <-> LF)'
                              : 'Automatic (by ASCII mask)'}
                          </span>
                        </label>
                      ))}
                      {options.transferMode === 'automatic' && (
                        <input
                          type="text"
                          value={options.asciiFileMask}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, asciiFileMask: e.target.value }))
                          }
                          placeholder="*.txt;*.html;..."
                          className={`w-full px-2 py-1 rounded border font-mono text-[10px] ${
                            isDark ? 'bg-[#141414] border-[#454545]' : 'bg-white border-slate-300'
                          }`}
                        />
                      )}
                      {options.transferMode !== 'binary' && (
                        <label className="flex items-center gap-1.5 cursor-pointer pt-0.5">
                          <input
                            type="checkbox"
                            checked={options.removeBomEof}
                            onChange={(e) =>
                              setOptions((o) => ({ ...o, removeBomEof: e.target.checked }))
                            }
                          />
                          <span>Remove UTF-8 BOM &amp; Ctrl-Z EOF</span>
                        </label>
                      )}
                    </div>

                    {/* Common / Resume / Permissions */}
                    <div className={`p-2 rounded border space-y-1.5 ${isDark ? 'border-[#383838] bg-[#1e1e1e]' : 'border-slate-200 bg-slate-50'}`}>
                      <div className="font-semibold text-[11px]">Common &amp; Resume options</div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={options.preserveTimestamp}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, preserveTimestamp: e.target.checked }))
                          }
                        />
                        <span>Preserve timestamp (mtime)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={options.useFilepart}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, useFilepart: e.target.checked }))
                          }
                        />
                        <span>Enable .filepart temp &amp; resume</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={options.newerOnly}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, newerOnly: e.target.checked }))
                          }
                        />
                        <span>New and updated files only</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={options.excludeHidden}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, excludeHidden: e.target.checked }))
                          }
                        />
                        <span>Exclude hidden files</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={options.excludeEmptyDirs}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, excludeEmptyDirs: e.target.checked }))
                          }
                        />
                        <span>Exclude empty directories</span>
                      </label>
                    </div>
                  </div>

                  {/* Mask, Permissions, Conflict Policy, Speed & Workers */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block mb-1 opacity-80">File mask (include|exclude):</label>
                      <input
                        type="text"
                        value={options.fileMask}
                        onChange={(e) => setOptions((o) => ({ ...o, fileMask: e.target.value }))}
                        placeholder="*|node_modules/;*.tmp"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block mb-1 opacity-80">When target exists:</label>
                      <select
                        value={options.overwritePolicy}
                        onChange={(e) =>
                          setOptions((o) => ({
                            ...o,
                            overwritePolicy: e.target.value as OverwritePolicy,
                          }))
                        }
                        className={inputCls}
                      >
                        <option value="ask">Ask (Prompt Overwrite / Resume)</option>
                        <option value="overwrite">Overwrite existing</option>
                        <option value="resume">Resume (.filepart / offset)</option>
                        <option value="rename">Auto-rename target</option>
                        <option value="newer_only">Overwrite newer only</option>
                        <option value="skip">Skip existing</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 items-end">
                    <div>
                      <label className="block mb-1 opacity-80">Speed limit (KB/s):</label>
                      <select
                        value={options.speedLimitKbps}
                        onChange={(e) =>
                          setOptions((o) => ({ ...o, speedLimitKbps: Number(e.target.value) }))
                        }
                        className={inputCls}
                      >
                        <option value={0}>Unlimited</option>
                        <option value={1024}>1024 KB/s</option>
                        <option value={512}>512 KB/s</option>
                        <option value={256}>256 KB/s</option>
                        <option value={128}>128 KB/s</option>
                        <option value={64}>64 KB/s</option>
                        <option value={32}>32 KB/s</option>
                      </select>
                    </div>
                    <div>
                      <label className="block mb-1 opacity-80">Parallel workers:</label>
                      <select
                        value={maxConcurrent}
                        onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                        className={inputCls}
                      >
                        {[1, 2, 3, 4, 6, 8].map((n) => (
                          <option key={n} value={n}>
                            {n} worker{n > 1 ? 's' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    {copyDialogPreset.direction === 'upload' && (
                      <div>
                        <label className="flex items-center gap-1.5 mb-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={options.preserveRights}
                            onChange={(e) =>
                              setOptions((o) => ({ ...o, preserveRights: e.target.checked }))
                            }
                          />
                          <span>Set chmod:</span>
                        </label>
                        <input
                          type="text"
                          disabled={!options.preserveRights}
                          value={options.octalRights ?? '0644'}
                          onChange={(e) =>
                            setOptions((o) => ({ ...o, octalRights: e.target.value }))
                          }
                          className={`${inputCls} disabled:opacity-45`}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-xs pt-0.5">
              <input
                type="checkbox"
                checked={options.backgroundQueue}
                onChange={(e) =>
                  setOptions((o) => ({ ...o, backgroundQueue: e.target.checked }))
                }
              />
              <span>Transfer in background (add directly to transfer queue dock)</span>
            </label>

            <div className="flex justify-end gap-2 pt-2 border-t border-black/10 dark:border-white/10">
              <button
                type="button"
                onClick={closeModal}
                className={`px-3 py-1.5 rounded border text-xs ${
                  isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
                }`}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-1.5 rounded bg-[#10b981] hover:bg-[#059669] disabled:opacity-50 text-white text-xs font-medium"
              >
                {busy ? 'Enqueueing...' : titleVerb}
              </button>
            </div>
          </form>
        </div>
      </div>
      <ForegroundProgressModal />
    </>
  );
}
