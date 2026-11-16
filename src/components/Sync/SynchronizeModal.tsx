import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  FolderSync,
  Loader2,
  Minimize2,
  Play,
  Square,
  X,
} from 'lucide-react';
import {
  syncApi,
  type KeepUpToDateStatus,
  type SyncCompareSummary,
  type SyncDirection,
  type SyncMode,
} from '../../services/phase5Api';
import {
  getTargetEntriesForPane,
  useWorkspaceStore,
} from '../../stores/useWorkspaceStore';
import { SyncChecklistModal } from './SyncChecklistModal';

export function SynchronizeModal() {
  const {
    theme,
    activeModal,
    rightPaneMode,
    activeTabId,
    leftPane,
    rightPane,
    closeModal,
    refreshPane,
    addQueueLog,
    setKeepUpToDateActive,
  } = useWorkspaceStore();

  const isOpen = activeModal === 'synchronize' || activeModal === 'keep_up_to_date';
  const isDark = theme === 'dark';
  const targetIsRemote = rightPaneMode === 'remote_sftp';
  const targetReady =
    rightPaneMode === 'remote_sftp' || rightPaneMode === 'local_secondary';

  const [modeTab, setModeTab] = useState<'synchronize' | 'keep_up_to_date'>('synchronize');

  // Synchronize Directories state
  const [localDir, setLocalDir] = useState('');
  const [remoteDir, setRemoteDir] = useState('');
  const [direction, setDirection] = useState<SyncDirection>('remote');
  const [syncMode, setSyncMode] = useState<SyncMode>('synchronize_files');
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [previewChanges, setPreviewChanges] = useState(true);
  const [existingFilesOnly, setExistingFilesOnly] = useState(false);
  const [selectedFilesOnly, setSelectedFilesOnly] = useState(false);
  const [byTime, setByTime] = useState(true);
  const [bySize, setBySize] = useState(false);
  const [byChecksum, setByChecksum] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fileMask, setFileMask] = useState('*');
  const [comparing, setComparing] = useState(false);
  const [checklistSummary, setChecklistSummary] = useState<SyncCompareSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Keep Remote Directory up to Date state
  const [watchLocalDir, setWatchLocalDir] = useState('');
  const [watchRemoteDir, setWatchRemoteDir] = useState('');
  const [watchDeleteFiles, setWatchDeleteFiles] = useState(false);
  const [watchRecursive, setWatchRecursive] = useState(true);
  const [watchExistingOnly, setWatchExistingOnly] = useState(false);
  const [watchSelectedOnly, setWatchSelectedOnly] = useState(false);
  const [watchSyncOnStart, setWatchSyncOnStart] = useState(true);
  const [watchFileMask, setWatchFileMask] = useState('*');
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchStatus, setWatchStatus] = useState<KeepUpToDateStatus | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setModeTab(activeModal === 'keep_up_to_date' ? 'keep_up_to_date' : 'synchronize');
    setLocalDir(leftPane.currentPath || '');
    setRemoteDir(rightPane.currentPath || '');
    setWatchLocalDir((prev) => prev || leftPane.currentPath || '');
    setWatchRemoteDir((prev) => prev || rightPane.currentPath || '');
    setChecklistSummary(null);
    setSyncError(null);

    let cancelled = false;
    void syncApi
      .getKeepUpToDateStatus()
      .then((status) => {
        if (cancelled) return;
        setWatchStatus(status);
        setKeepUpToDateActive(status.running);
        if (status.running && status.localDir) {
          setWatchLocalDir(status.localDir);
        }
        if (status.running && status.remoteDir) {
          setWatchRemoteDir(status.remoteDir);
        }
      })
      .catch(() => {});

    let unlisten: (() => void) | null = null;
    void syncApi
      .onKeepUpToDate((status) => {
        if (!cancelled) {
          setWatchStatus(status);
          setKeepUpToDateActive(status.running);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activeModal, isOpen]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [watchStatus?.logs.length]);

  if (!isOpen) return null;

  const leftSelected = getTargetEntriesForPane(leftPane);
  const rightSelected = getTargetEntriesForPane(rightPane);
  const selectedRelPaths = Array.from(
    new Set([...leftSelected.map((e) => e.name), ...rightSelected.map((e) => e.name)]),
  );

  const handleModeChange = (next: SyncMode) => {
    setSyncMode(next);
    if (next === 'mirror_files' && direction === 'both') {
      setDirection('remote');
    }
  };

  const handleRunSynchronize = async () => {
    if (!targetReady || !localDir.trim() || !remoteDir.trim()) {
      setSyncError('Both local and target directories must be valid.');
      return;
    }
    setComparing(true);
    setSyncError(null);
    try {
      const summary = await syncApi.compareDirectories({
        sessionId: targetIsRemote ? activeTabId : null,
        localDir: localDir.trim(),
        remoteDir: remoteDir.trim(),
        targetIsRemote,
        direction,
        mode: syncMode,
        deleteFiles,
        existingFilesOnly,
        selectedFilesOnly,
        selectedRelPaths: selectedFilesOnly ? selectedRelPaths : [],
        byTime,
        bySize,
        byChecksum,
        caseSensitive,
        fileMask: fileMask.trim() || '*',
      });

      if (previewChanges) {
        setChecklistSummary(summary);
        setComparing(false);
        return;
      }

      let executed = 0;
      if (summary.items.length > 0) {
        executed = await syncApi.executeChecklist({
          sessionId: targetIsRemote ? activeTabId : null,
          localDir: summary.localDir,
          remoteDir: summary.remoteDir,
          targetIsRemote: summary.targetIsRemote,
          items: summary.items,
        });
      }

      addQueueLog({
        operation: 'copy',
        source: summary.localDir,
        target: summary.remoteDir,
        status: 'done',
        detail:
          executed > 0
            ? `Synchronized ${executed} item(s).`
            : 'Synchronize: directories already up to date.',
      });
      await Promise.all([refreshPane('left'), refreshPane('right')]);
      setComparing(false);
      closeModal();
    } catch (err) {
      setSyncError(String(err));
      setComparing(false);
    }
  };

  const handleChecklistExecuted = async (count: number) => {
    addQueueLog({
      operation: 'copy',
      source: checklistSummary?.localDir || localDir,
      target: checklistSummary?.remoteDir || remoteDir,
      status: 'done',
      detail: `Synchronized ${count} item(s) via checklist.`,
    });
    setChecklistSummary(null);
    await Promise.all([refreshPane('left'), refreshPane('right')]);
    closeModal();
  };

  const handleStartWatch = async () => {
    if (!targetReady || !watchLocalDir.trim() || !watchRemoteDir.trim()) {
      setSyncError('Connect to a remote session or switch the right pane to Local mode.');
      return;
    }
    setWatchBusy(true);
    setSyncError(null);
    try {
      const status = await syncApi.startKeepUpToDate({
        sessionId: targetIsRemote ? activeTabId : null,
        localDir: watchLocalDir.trim(),
        remoteDir: watchRemoteDir.trim(),
        targetIsRemote,
        deleteFiles: watchDeleteFiles,
        existingFilesOnly: watchExistingOnly,
        recursive: watchRecursive,
        selectedOnly: watchSelectedOnly,
        selectedPaths: watchSelectedOnly ? leftSelected.map((e) => e.name) : [],
        fileMask: watchFileMask.trim() || '*',
        synchronizeOnStart: watchSyncOnStart,
      });
      setWatchStatus(status);
      setKeepUpToDateActive(status.running);
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setWatchBusy(false);
    }
  };

  const handleStopWatch = async () => {
    setWatchBusy(true);
    setSyncError(null);
    try {
      const status = await syncApi.stopKeepUpToDate();
      setWatchStatus(status);
      setKeepUpToDateActive(status.running);
      await refreshPane('right');
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setWatchBusy(false);
    }
  };

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1e1e1e] border-[#3c3c3f] text-[#d4d4d4] focus:border-emerald-500'
      : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
  }`;

  const groupBoxCls = `rounded border p-3 ${
    isDark ? 'border-[#333337] bg-[#1e1e1e]/60' : 'border-slate-200 bg-slate-50/70'
  }`;

  const targetTitle = targetIsRemote ? 'Remote' : 'Target Local';
  const isWatching = Boolean(watchStatus?.running);

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !comparing) closeModal();
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
              <FolderSync className="w-4 h-4 text-emerald-400" />
              <span>Synchronize</span>
            </div>
            <button
              type="button"
              disabled={comparing}
              onClick={closeModal}
              className="p-0.5 rounded opacity-70 hover:opacity-100 disabled:opacity-30"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div
            className={`flex items-center gap-1 px-4 pt-2 border-b ${
              isDark ? 'bg-[#202022] border-[#333337]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <button
              type="button"
              onClick={() => setModeTab('synchronize')}
              className={`px-3 py-1.5 rounded-t border-b-2 font-medium text-[11px] transition-colors ${
                modeTab === 'synchronize'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              Synchronize Directories
            </button>
            <button
              type="button"
              onClick={() => setModeTab('keep_up_to_date')}
              className={`px-3 py-1.5 rounded-t border-b-2 font-medium text-[11px] inline-flex items-center gap-1.5 transition-colors ${
                modeTab === 'keep_up_to_date'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <span>Keep Remote Directory up to Date</span>
              {isWatching && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          </div>

          {!targetReady && (
            <div className="mx-4 mt-3 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[11px]">
              Right pane is not connected to SFTP. Connect a remote session or switch the right pane to Local mode to synchronize.
            </div>
          )}

          {modeTab === 'synchronize' ? (
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">Local directory</label>
                  <input
                    type="text"
                    value={localDir}
                    onChange={(e) => setLocalDir(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">
                    {targetTitle} directory
                  </label>
                  <input
                    type="text"
                    value={remoteDir}
                    onChange={(e) => setRemoteDir(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className={groupBoxCls}>
                  <div className="font-semibold text-[11px] mb-2 opacity-90">
                    Direction / Target
                  </div>
                  <div className="space-y-1.5">
                    {(
                      [
                        { value: 'remote', label: `${targetTitle} (Local -> ${targetTitle})` },
                        { value: 'local', label: `Local (${targetTitle} -> Local)` },
                        { value: 'both', label: 'Both (Bidirectional)' },
                      ] as const
                    ).map((opt) => (
                      <label
                        key={opt.value}
                        className="flex items-center gap-2 cursor-pointer text-[11px]"
                      >
                        <input
                          type="radio"
                          name="syncDirection"
                          checked={direction === opt.value}
                          disabled={opt.value === 'both' && syncMode === 'mirror_files'}
                          onChange={() => setDirection(opt.value)}
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className={groupBoxCls}>
                  <div className="font-semibold text-[11px] mb-2 opacity-90">Mode</div>
                  <div className="space-y-1.5">
                    {(
                      [
                        { value: 'synchronize_files', label: 'Synchronize files' },
                        { value: 'mirror_files', label: 'Mirror files' },
                        { value: 'synchronize_timestamps', label: 'Synchronize timestamps' },
                      ] as const
                    ).map((opt) => (
                      <label
                        key={opt.value}
                        className="flex items-center gap-2 cursor-pointer text-[11px]"
                      >
                        <input
                          type="radio"
                          name="syncMode"
                          checked={syncMode === opt.value}
                          onChange={() => handleModeChange(opt.value)}
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className={groupBoxCls}>
                  <div className="font-semibold text-[11px] mb-2 opacity-90">
                    Synchronize options
                  </div>
                  <div className="space-y-1.5 text-[11px]">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deleteFiles}
                        onChange={(e) => setDeleteFiles(e.target.checked)}
                      />
                      <span>Delete obsolete files</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={previewChanges}
                        onChange={(e) => setPreviewChanges(e.target.checked)}
                      />
                      <span>Preview changes (Checklist)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={existingFilesOnly}
                        onChange={(e) => setExistingFilesOnly(e.target.checked)}
                      />
                      <span>Existing files only</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedFilesOnly}
                        disabled={selectedRelPaths.length === 0}
                        onChange={(e) => setSelectedFilesOnly(e.target.checked)}
                      />
                      <span className={selectedRelPaths.length === 0 ? 'opacity-50' : ''}>
                        Selected files only ({selectedRelPaths.length})
                      </span>
                    </label>
                  </div>
                </div>

                <div className={groupBoxCls}>
                  <div className="font-semibold text-[11px] mb-2 opacity-90">
                    Comparison criteria
                  </div>
                  <div className="space-y-1.5 text-[11px]">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={byTime}
                        onChange={(e) => setByTime(e.target.checked)}
                      />
                      <span>Modification time</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bySize}
                        onChange={(e) => setBySize(e.target.checked)}
                      />
                      <span>File size</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={byChecksum}
                        onChange={(e) => setByChecksum(e.target.checked)}
                      />
                      <span>Checksum (SHA-256)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={caseSensitive}
                        onChange={(e) => setCaseSensitive(e.target.checked)}
                      />
                      <span>Case sensitive filenames</span>
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <label className="block mb-1 text-[11px] opacity-80">
                  File mask (WinSCP include|exclude/, e.g. *.ts|node_modules/)
                </label>
                <input
                  type="text"
                  value={fileMask}
                  onChange={(e) => setFileMask(e.target.value)}
                  placeholder="*"
                  className={inputCls}
                />
              </div>

              {syncError && (
                <div className="px-3 py-1.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-400 text-[11px]">
                  {syncError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={comparing}
                  onClick={closeModal}
                  className={`px-3 py-1.5 rounded border text-xs ${
                    isDark
                      ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                      : 'border-slate-300 hover:bg-slate-100 disabled:opacity-40'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={comparing || !targetReady}
                  onClick={() => void handleRunSynchronize()}
                  className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
                >
                  {comparing ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Comparing...
                    </>
                  ) : (
                    <>
                      <FolderSync className="w-3.5 h-3.5" />
                      {previewChanges ? 'Compare & Preview...' : 'Synchronize Now'}
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">
                    Watch local directory
                  </label>
                  <input
                    type="text"
                    disabled={isWatching}
                    value={watchLocalDir}
                    onChange={(e) => setWatchLocalDir(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">
                    {targetTitle} directory
                  </label>
                  <input
                    type="text"
                    disabled={isWatching}
                    value={watchRemoteDir}
                    onChange={(e) => setWatchRemoteDir(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className={groupBoxCls}>
                  <div className="font-semibold text-[11px] mb-2 opacity-90">
                    Watch options
                  </div>
                  <div className="space-y-1.5 text-[11px]">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isWatching}
                        checked={watchDeleteFiles}
                        onChange={(e) => setWatchDeleteFiles(e.target.checked)}
                      />
                      <span>Delete removed files on target</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isWatching}
                        checked={watchRecursive}
                        onChange={(e) => setWatchRecursive(e.target.checked)}
                      />
                      <span>Update subdirectories</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isWatching}
                        checked={watchExistingOnly}
                        onChange={(e) => setWatchExistingOnly(e.target.checked)}
                      />
                      <span>Existing files only</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isWatching || leftSelected.length === 0}
                        checked={watchSelectedOnly}
                        onChange={(e) => setWatchSelectedOnly(e.target.checked)}
                      />
                      <span className={leftSelected.length === 0 ? 'opacity-50' : ''}>
                        Selected files only ({leftSelected.length})
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={isWatching}
                        checked={watchSyncOnStart}
                        onChange={(e) => setWatchSyncOnStart(e.target.checked)}
                      />
                      <span>Synchronize on start</span>
                    </label>
                  </div>
                </div>

                <div className={groupBoxCls}>
                  <div className="font-semibold text-[11px] mb-2 opacity-90">
                    Filter & Watcher Status
                  </div>
                  <label className="block mb-1 text-[10px] opacity-70">File mask</label>
                  <input
                    type="text"
                    disabled={isWatching}
                    value={watchFileMask}
                    onChange={(e) => setWatchFileMask(e.target.value)}
                    placeholder="*"
                    className={`${inputCls} mb-3`}
                  />
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Activity
                        className={`w-3.5 h-3.5 ${
                          isWatching ? 'text-emerald-400 animate-pulse' : 'opacity-50'
                        }`}
                      />
                      {isWatching ? 'Watching' : 'Stopped'}
                    </span>
                    <span className="opacity-75">
                      Synced: <strong>{watchStatus?.syncedCount ?? 0}</strong>
                    </span>
                    <span className="opacity-75">
                      Errors: <strong>{watchStatus?.errorCount ?? 0}</strong>
                    </span>
                  </div>
                </div>
              </div>

              <div className={groupBoxCls}>
                <div className="font-semibold text-[11px] mb-1.5 opacity-90">Logs</div>
                <div
                  className={`h-36 overflow-y-auto rounded border p-2 font-mono text-[10px] space-y-1 ${
                    isDark
                      ? 'bg-[#141416] border-[#2d2d30]'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  {!watchStatus || watchStatus.logs.length === 0 ? (
                    <div className="opacity-50">
                      Click Start to monitor local changes and auto-upload every ~300ms.
                    </div>
                  ) : (
                    watchStatus.logs.map((entry, idx) => (
                      <div key={`${entry.timestampMs}-${idx}`} className="flex items-start gap-2">
                        <span className="opacity-50 shrink-0">
                          {new Date(entry.timestampMs).toLocaleTimeString()}
                        </span>
                        <span
                          className={`uppercase font-semibold shrink-0 ${
                            entry.status === 'error'
                              ? 'text-rose-400'
                              : entry.action === 'delete'
                                ? 'text-amber-400'
                                : 'text-emerald-400'
                          }`}
                        >
                          [{entry.action}]
                        </span>
                        <span className="truncate">
                          {entry.relativePath ? `${entry.relativePath}: ` : ''}
                          {entry.detail}
                        </span>
                      </div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>

              {syncError && (
                <div className="px-3 py-1.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-400 text-[11px]">
                  {syncError}
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={closeModal}
                  title="Close dialog while keeping watcher running in background"
                  className={`px-3 py-1.5 rounded border text-xs inline-flex items-center gap-1.5 ${
                    isDark
                      ? 'border-[#454545] hover:bg-[#323233]'
                      : 'border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  Minimize
                </button>

                <div className="flex items-center gap-2">
                  {isWatching ? (
                    <button
                      type="button"
                      disabled={watchBusy}
                      onClick={() => void handleStopWatch()}
                      className="px-4 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <Square className="w-3.5 h-3.5" />
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={watchBusy || !targetReady}
                      onClick={() => void handleStartWatch()}
                      className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Start
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {checklistSummary && (
        <SyncChecklistModal
          summary={checklistSummary}
          sessionId={targetIsRemote ? activeTabId : null}
          onClose={() => setChecklistSummary(null)}
          onExecuted={(count) => void handleChecklistExecuted(count)}
        />
      )}
    </>
  );
}
