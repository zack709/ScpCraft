import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  ClipboardCopy,
  Crosshair,
  Download,
  File,
  FileEdit,
  Folder,
  Loader2,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { localFsApi } from '../../services/localFsApi';
import { syncApi, type FileFindMatch } from '../../services/phase5Api';
import { sftpApi } from '../../services/sftpApi';
import { buildDefaultTransferOptions } from '../../services/transferApi';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { formatBytes, formatDateTime } from '../../utils/formatters';

export function RemoteFindModal() {
  const {
    theme,
    activeModal,
    modalPane,
    rightPaneMode,
    activeTabId,
    leftPane,
    rightPane,
    transferPreset,
    closeModal,
    navigateTo,
    selectSingle,
    openFileInEditor,
    enqueueTransfer,
    refreshPane,
    addQueueLog,
  } = useWorkspaceStore();

  const isOpen = activeModal === 'find_files';
  const isDark = theme === 'dark';
  const sourcePane = modalPane === 'left' ? leftPane : rightPane;
  const targetPane = modalPane === 'left' ? rightPane : leftPane;
  const isRemote = modalPane === 'right' && rightPaneMode === 'remote_sftp';
  const sourceReady =
    modalPane === 'left' ||
    rightPaneMode === 'remote_sftp' ||
    rightPaneMode === 'local_secondary';
  const oppositeReady =
    modalPane === 'right' ||
    rightPaneMode === 'remote_sftp' ||
    rightPaneMode === 'local_secondary';

  const [fileMask, setFileMask] = useState('*');
  const [baseDir, setBaseDir] = useState('');
  const [contentKeyword, setContentKeyword] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [recursive, setRecursive] = useState(true);
  const [searching, setSearching] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [results, setResults] = useState<FileFindMatch[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setBaseDir(sourcePane.currentPath || (isRemote ? '~' : ''));
    setResults([]);
    setSelectedPath(null);
    setConfirmDeletePath(null);
    setCopiedNotice(false);
    setHasSearched(false);
    setError(null);
  }, [isOpen, modalPane]);

  if (!isOpen) return null;

  const selectedMatch =
    results.find((r) => r.fullPath === selectedPath) ?? results[0] ?? null;

  const handleSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!sourceReady || !baseDir.trim()) {
      setError('Select a connected remote session or valid local directory to search.');
      return;
    }
    setSearching(true);
    setError(null);
    setConfirmDeletePath(null);
    try {
      const matches = await syncApi.findFiles({
        pane: modalPane,
        sessionId: isRemote ? activeTabId : null,
        isRemote,
        baseDir: baseDir.trim(),
        fileMask: fileMask.trim() || '*',
        contentKeyword,
        caseSensitive,
        recursive,
        maxResults: 1000,
      });
      setResults(matches);
      setSelectedPath(matches[0]?.fullPath ?? null);
      setHasSearched(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSearching(false);
    }
  };

  const handleFocus = async (match: FileFindMatch) => {
    if (!match.directory) return;
    setBusyAction(true);
    setError(null);
    try {
      await navigateTo(modalPane, match.directory, true);
      selectSingle(modalPane, match.fullPath);
      closeModal();
    } catch (err) {
      setError(String(err));
      setBusyAction(false);
    }
  };

  const handleEdit = async (match: FileFindMatch) => {
    if (match.isDir) return;
    closeModal();
    await openFileInEditor(modalPane, match.fullPath);
  };

  const handleTransferToOpposite = async (match: FileFindMatch) => {
    if (!oppositeReady || !targetPane.currentPath) {
      setError('Target pane is not ready for transfer.');
      return;
    }
    setBusyAction(true);
    setError(null);
    try {
      const direction =
        rightPaneMode === 'remote_sftp'
          ? modalPane === 'left'
            ? 'upload'
            : 'download'
          : 'local_copy';
      const options = buildDefaultTransferOptions(
        direction,
        direction === 'local_copy' ? null : activeTabId,
        false,
        transferPreset,
      );
      await enqueueTransfer(
        {
          sources: [match.fullPath],
          targetDir: targetPane.currentPath,
          options,
        },
        true,
      );
      setBusyAction(false);
    } catch (err) {
      setError(String(err));
      setBusyAction(false);
    }
  };

  const handleDeleteConfirmed = async (match: FileFindMatch) => {
    setBusyAction(true);
    setError(null);
    try {
      if (isRemote) {
        await sftpApi.delete(activeTabId, [match.fullPath]);
      } else {
        await localFsApi.delete([match.fullPath], true);
      }
      addQueueLog({
        operation: 'delete',
        source: match.fullPath,
        target: isRemote ? 'Remote Delete' : 'Recycle Bin',
        status: 'done',
        detail: `Deleted from Find results: ${match.name}`,
      });
      setResults((prev) => {
        const next = prev.filter((item) => item.fullPath !== match.fullPath);
        setSelectedPath(next[0]?.fullPath ?? null);
        return next;
      });
      setConfirmDeletePath(null);
      await refreshPane(modalPane);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleCopyResults = async () => {
    if (results.length === 0) return;
    const text = results
      .map((r) => {
        const lineInfo =
          r.matchedLine != null ? ` (line ${r.matchedLine}: ${r.matchedPreview ?? ''})` : '';
        return `${r.fullPath}${lineInfo}`;
      })
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedNotice(true);
      setTimeout(() => setCopiedNotice(false), 1800);
    } catch (err) {
      setError(`Failed copying results: ${String(err)}`);
    }
  };

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1e1e1e] border-[#3c3c3f] text-[#d4d4d4] focus:border-emerald-500'
      : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
  }`;

  const actionBtnCls = (disabled: boolean) =>
    `w-full px-2.5 py-1.5 rounded border text-[11px] font-medium inline-flex items-center gap-1.5 justify-start transition-colors ${
      disabled
        ? isDark
          ? 'border-[#333337] text-[#666666] cursor-not-allowed'
          : 'border-slate-200 text-slate-400 cursor-not-allowed'
        : isDark
          ? 'border-[#454545] bg-[#2d2d30] hover:bg-[#38383c] text-[#e0e0e0]'
          : 'border-slate-300 bg-slate-50 hover:bg-slate-200 text-slate-800'
    }`;

  const transferVerb = isRemote
    ? 'Download'
    : rightPaneMode === 'remote_sftp'
      ? 'Upload'
      : 'Copy';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !searching && !busyAction) closeModal();
      }}
    >
      <div
        className={`w-full max-w-4xl max-h-[86vh] flex flex-col rounded-lg border shadow-2xl overflow-hidden text-xs ${
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
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-sky-400" />
            <span>
              Find Files (Alt+F7) — {isRemote ? 'Remote SFTP' : `Local (${modalPane})`}
            </span>
          </div>
          <button
            type="button"
            disabled={searching}
            onClick={closeModal}
            className="p-0.5 rounded opacity-70 hover:opacity-100 disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => void handleSearch(e)}
          className={`p-4 border-b space-y-2.5 shrink-0 ${
            isDark ? 'bg-[#202022] border-[#333337]' : 'bg-slate-50 border-slate-200'
          }`}
        >
          {!sourceReady && (
            <div className="px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[11px]">
              Active pane is not connected to a remote SFTP server.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block mb-1 text-[11px] opacity-80">
                File mask (supports include|exclude/, e.g. *.ts|node_modules/)
              </label>
              <input
                type="text"
                autoFocus
                value={fileMask}
                onChange={(e) => setFileMask(e.target.value)}
                placeholder="*.*"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block mb-1 text-[11px] opacity-80">Search in directory</label>
              <input
                type="text"
                value={baseDir}
                onChange={(e) => setBaseDir(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[220px]">
              <label className="block mb-1 text-[11px] opacity-80">
                Containing text (optional content grep)
              </label>
              <input
                type="text"
                value={contentKeyword}
                onChange={(e) => setContentKeyword(e.target.value)}
                placeholder="Search file contents..."
                className={inputCls}
              />
            </div>

            <label className="flex items-center gap-1.5 pb-1.5 cursor-pointer text-[11px]">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              <span>Case sensitive</span>
            </label>

            <label className="flex items-center gap-1.5 pb-1.5 cursor-pointer text-[11px]">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
              />
              <span>Include subdirectories</span>
            </label>

            <button
              type="submit"
              disabled={searching || !sourceReady}
              className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              {searching ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-3.5 h-3.5" />
                  Start
                </>
              )}
            </button>
          </div>
        </form>

        <div className="flex-1 min-h-[260px] flex overflow-hidden">
          <div className="flex-1 overflow-auto">
            {results.length === 0 ? (
              <div className="h-full min-h-[220px] flex items-center justify-center opacity-55 text-xs">
                {searching
                  ? 'Scanning files...'
                  : hasSearched
                    ? 'No matching files or directories found.'
                    : 'Enter a file mask or text keyword and click Start.'}
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
                    <th className="px-2.5 py-1.5">Name</th>
                    <th className="px-2.5 py-1.5">Directory</th>
                    <th className="px-2.5 py-1.5 w-20 text-right">Size</th>
                    <th className="px-2.5 py-1.5 w-40">Modified</th>
                    <th className="px-2.5 py-1.5">Match Preview</th>
                  </tr>
                </thead>
                <tbody className={isDark ? 'divide-y divide-[#303034]' : 'divide-y divide-slate-200'}>
                  {results.map((match) => {
                    const isSelected = selectedMatch?.fullPath === match.fullPath;
                    return (
                      <tr
                        key={match.fullPath}
                        onClick={() => {
                          setSelectedPath(match.fullPath);
                          setConfirmDeletePath(null);
                        }}
                        onDoubleClick={() => void handleFocus(match)}
                        className={`cursor-pointer ${
                          isSelected
                            ? isDark
                              ? 'bg-[#094771] text-white'
                              : 'bg-[#cce8ff] text-slate-900'
                            : isDark
                              ? 'hover:bg-[#2a2d2e]'
                              : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {match.isDir ? (
                              <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            ) : (
                              <File className="w-3.5 h-3.5 opacity-75 shrink-0" />
                            )}
                            <span className="truncate max-w-[180px]" title={match.name}>
                              {match.name}
                            </span>
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[10px] opacity-85 truncate max-w-[220px]" title={match.directory}>
                          {match.directory}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-right text-[10px]">
                          {match.isDir ? '<DIR>' : formatBytes(match.size)}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[10px] opacity-80 whitespace-nowrap">
                          {formatDateTime(match.modifiedMs)}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[10px] opacity-80 truncate max-w-[220px]" title={match.matchedPreview ?? ''}>
                          {match.matchedLine != null ? (
                            <span>
                              <strong className="text-sky-400 mr-1">L{match.matchedLine}:</strong>
                              {match.matchedPreview}
                            </span>
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

          <div
            className={`w-36 p-2.5 border-l flex flex-col gap-1.5 shrink-0 ${
              isDark ? 'bg-[#202022] border-[#333337]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <button
              type="button"
              disabled={!selectedMatch || busyAction}
              onClick={() => selectedMatch && void handleFocus(selectedMatch)}
              className={actionBtnCls(!selectedMatch || busyAction)}
            >
              <Crosshair className="w-3.5 h-3.5 text-sky-400" />
              Focus
            </button>

            <button
              type="button"
              disabled={!selectedMatch || selectedMatch.isDir || busyAction}
              onClick={() => selectedMatch && void handleEdit(selectedMatch)}
              className={actionBtnCls(!selectedMatch || selectedMatch.isDir || busyAction)}
            >
              <FileEdit className="w-3.5 h-3.5 text-amber-400" />
              Edit
            </button>

            <button
              type="button"
              disabled={!selectedMatch || !oppositeReady || busyAction}
              onClick={() => selectedMatch && void handleTransferToOpposite(selectedMatch)}
              className={actionBtnCls(!selectedMatch || !oppositeReady || busyAction)}
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              {transferVerb}
            </button>

            <button
              type="button"
              disabled={!selectedMatch || busyAction}
              onClick={() =>
                selectedMatch && setConfirmDeletePath(selectedMatch.fullPath)
              }
              className={actionBtnCls(!selectedMatch || busyAction)}
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              Delete
            </button>

            <div className="my-1 border-t border-current/10" />

            <button
              type="button"
              disabled={results.length === 0}
              onClick={() => void handleCopyResults()}
              className={actionBtnCls(results.length === 0)}
            >
              {copiedNotice ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <ClipboardCopy className="w-3.5 h-3.5 opacity-80" />
              )}
              {copiedNotice ? 'Copied!' : 'Copy Results'}
            </button>
          </div>
        </div>

        {confirmDeletePath && selectedMatch && (
          <div className="px-4 py-2 bg-rose-500/15 border-t border-rose-500/30 flex items-center justify-between gap-2 text-[11px] shrink-0">
            <span className="text-rose-300 truncate">
              Delete {isRemote ? 'remote' : 'local'} item:{' '}
              <strong className="font-mono">{selectedMatch.fullPath}</strong>?
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                disabled={busyAction}
                onClick={() => setConfirmDeletePath(null)}
                className="px-2.5 py-0.5 rounded border border-rose-400/30 hover:bg-rose-500/20"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction}
                onClick={() => void handleDeleteConfirmed(selectedMatch)}
                className="px-2.5 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-medium"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 py-1.5 bg-rose-500/15 border-t border-rose-500/30 text-rose-400 text-[11px] shrink-0">
            {error}
          </div>
        )}

        <div
          className={`px-4 py-2 border-t flex items-center justify-between text-[11px] shrink-0 ${
            isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <span className="opacity-75">
            {results.length} item(s) matched
            {results.length >= 1000 ? ' (truncated at 1000)' : ''}
          </span>
          <button
            type="button"
            onClick={closeModal}
            className={`px-3 py-1 rounded border text-xs ${
              isDark
                ? 'border-[#454545] hover:bg-[#323233]'
                : 'border-slate-300 hover:bg-slate-200'
            }`}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
