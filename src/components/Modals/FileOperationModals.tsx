import { useEffect, useState, type FormEvent } from 'react';
import { Bookmark, FolderInput, Plus, Trash2, X } from 'lucide-react';
import type { LocationProfile } from '../../services/sftpApi';
import {
  getTargetEntriesForPane,
  getTargetPathsForPane,
  useWorkspaceStore,
} from '../../stores/useWorkspaceStore';
import { CreateDirModal } from './CreateDirModal';
import { PropertiesModal } from './PropertiesModal';
import { SymlinkModal } from './SymlinkModal';

function BookmarksModal() {
  const {
    theme,
    activeModal,
    rightPaneMode,
    leftPane,
    rightPane,
    tabs,
    activeTabId,
    bookmarks,
    loadBookmarks,
    saveBookmarks,
    navigateTo,
    closeModal,
  } = useWorkspaceStore();

  const activeSite = tabs.find((t) => t.id === activeTabId)?.site ?? null;
  const [scopeTab, setScopeTab] = useState<'session' | 'shared'>('session');
  const [newName, setNewName] = useState('');
  const [newLocal, setNewLocal] = useState('');
  const [newRemote, setNewRemote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeModal === 'bookmarks') {
      setError(null);
      setScopeTab(activeSite ? 'session' : 'shared');
      setNewName('');
      setNewLocal(leftPane.currentPath);
      setNewRemote(rightPaneMode === 'remote_sftp' ? rightPane.currentPath : '');
      void loadBookmarks(activeSite?.id ?? null);
    }
  }, [activeModal]);

  if (activeModal !== 'bookmarks') return null;

  const isDark = theme === 'dark';
  const sessionList = bookmarks.filter((b) => activeSite && b.siteId === activeSite.id);
  const sharedList = bookmarks.filter((b) => !b.siteId);
  const visibleList = scopeTab === 'session' ? sessionList : sharedList;

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const label = newName.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      const next: LocationProfile[] = [
        ...bookmarks,
        {
          id: `bm_${Date.now()}`,
          name: label,
          localPath: newLocal.trim(),
          remotePath: newRemote.trim(),
          siteId: scopeTab === 'session' && activeSite ? activeSite.id : null,
        },
      ];
      await saveBookmarks(next);
      setNewName('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await saveBookmarks(bookmarks.filter((b) => b.id !== id));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenBookmark = async (bm: LocationProfile) => {
    try {
      if (bm.localPath.trim()) {
        await navigateTo('left', bm.localPath.trim(), true);
      }
      if (bm.remotePath.trim() && rightPaneMode === 'remote_sftp') {
        await navigateTo('right', bm.remotePath.trim(), true);
      }
      closeModal();
    } catch (err) {
      setError(String(err));
    }
  };

  const inputCls = `w-full px-2 py-1 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1b1b1c] border-[#454545] text-slate-100 focus:border-[#3b82f6]'
      : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className={`w-full max-w-xl rounded-lg border shadow-2xl overflow-hidden ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b text-xs font-semibold ${
            isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <Bookmark className="w-4 h-4 text-amber-400" />
            <span>Open Directory / Location Bookmarks</span>
          </div>
          <button type="button" onClick={closeModal} className="p-0.5 rounded opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          {error && (
            <div className="p-2 rounded bg-red-500/20 border border-red-500/40 text-red-300">
              {error}
            </div>
          )}

          <div className="flex border-b border-black/10 dark:border-white/10 gap-1">
            {activeSite && (
              <button
                type="button"
                onClick={() => setScopeTab('session')}
                className={`px-3 py-1.5 rounded-t border-t border-x text-xs ${
                  scopeTab === 'session'
                    ? isDark
                      ? 'bg-[#1b1b1c] border-[#454545] font-semibold'
                      : 'bg-slate-50 border-slate-300 font-semibold'
                    : 'border-transparent opacity-70 hover:opacity-100'
                }`}
              >
                Session Bookmarks ({sessionList.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => setScopeTab('shared')}
              className={`px-3 py-1.5 rounded-t border-t border-x text-xs ${
                scopeTab === 'shared'
                  ? isDark
                    ? 'bg-[#1b1b1c] border-[#454545] font-semibold'
                    : 'bg-slate-50 border-slate-300 font-semibold'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              Shared Bookmarks ({sharedList.length})
            </button>
          </div>

          <div
            className={`max-h-48 overflow-y-auto rounded border ${
              isDark ? 'bg-[#1b1b1c] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            {visibleList.length === 0 ? (
              <div className="p-4 text-center opacity-60 text-[11px]">
                No bookmarks in this list yet. Save current folders below.
              </div>
            ) : (
              visibleList.map((bm) => (
                <div
                  key={bm.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 border-b last:border-b-0 border-black/10 dark:border-white/10"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{bm.name}</div>
                    <div className="text-[10px] font-mono opacity-70 truncate">
                      {bm.localPath ? `Local: ${bm.localPath}` : ''}
                      {bm.localPath && bm.remotePath ? '  |  ' : ''}
                      {bm.remotePath ? `Remote: ${bm.remotePath}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleOpenBookmark(bm)}
                      className="px-2 py-1 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-[11px] inline-flex items-center gap-1"
                    >
                      <FolderInput className="w-3 h-3" />
                      Open
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDelete(bm.id)}
                      className="p-1 rounded text-red-400 hover:bg-red-500/20"
                      title="Delete bookmark"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={(e) => void handleAdd(e)}
            className={`p-2.5 rounded border space-y-2 ${
              isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="font-semibold text-[11px]">Add Current Location Profile</div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block mb-0.5 text-[10px] opacity-70">Name</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Web Root"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block mb-0.5 text-[10px] opacity-70">Local directory</label>
                <input
                  type="text"
                  value={newLocal}
                  onChange={(e) => setNewLocal(e.target.value)}
                  placeholder="E:\Projects"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block mb-0.5 text-[10px] opacity-70">Remote directory</label>
                <input
                  type="text"
                  value={newRemote}
                  onChange={(e) => setNewRemote(e.target.value)}
                  placeholder="/var/www"
                  className={inputCls}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className="px-3 py-1 rounded bg-[#10b981] hover:bg-[#059669] text-white text-[11px] font-medium inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Save Bookmark
              </button>
            </div>
          </form>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={closeModal}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FileOperationModals() {
  const {
    theme,
    activeModal,
    modalPane,
    rightPaneMode,
    leftPane,
    rightPane,
    closeModal,
    createFile,
    renameEntry,
    deleteSelected,
    navigateTo,
    setFilterMask,
  } = useWorkspaceStore();

  const pane = modalPane === 'left' ? leftPane : rightPane;
  const targets = getTargetPathsForPane(pane);
  const targetEntries = getTargetEntriesForPane(pane);
  const firstEntry = targetEntries[0] ?? null;
  const isRemoteSftp = modalPane === 'right' && rightPaneMode === 'remote_sftp';

  const [inputValue, setInputValue] = useState('');
  const [useTrash, setUseTrash] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setBusy(false);
    if (activeModal === 'newfile') setInputValue('');
    else if (activeModal === 'rename') setInputValue(firstEntry?.name ?? '');
    else if (activeModal === 'opendir') setInputValue(pane.currentPath);
    else if (activeModal === 'filter') setInputValue(pane.filterMask);
    else if (activeModal === 'delete') setUseTrash(true);
  }, [activeModal]);

  if (
    activeModal === 'none' ||
    activeModal === 'copy' ||
    activeModal === 'move' ||
    activeModal === 'synchronize' ||
    activeModal === 'keep_up_to_date' ||
    activeModal === 'find_files' ||
    activeModal === 'custom_commands' ||
    activeModal === 'preferences' ||
    activeModal === 'cleanup' ||
    activeModal === 'generate_url'
  ) {
    return null;
  }
  if (activeModal === 'mkdir') return <CreateDirModal />;
  if (activeModal === 'symlink') return <SymlinkModal />;
  if (activeModal === 'properties') return <PropertiesModal />;
  if (activeModal === 'bookmarks') return <BookmarksModal />;

  const isDark = theme === 'dark';

  const modalTitleMap: Record<string, string> = {
    newfile: 'Create New File (Shift+F4)',
    rename: 'Rename Item (F2)',
    delete: 'Delete Confirmation (F8)',
    opendir: 'Open Directory (Ctrl+O)',
    filter: 'Filter File Mask (Ctrl+F)',
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (activeModal === 'newfile') {
        await createFile(modalPane, inputValue);
      } else if (activeModal === 'rename' && targets[0]) {
        await renameEntry(modalPane, targets[0], inputValue);
      } else if (activeModal === 'delete') {
        await deleteSelected(modalPane, isRemoteSftp ? false : useTrash);
      } else if (activeModal === 'opendir') {
        await navigateTo(modalPane, inputValue, true);
      } else if (activeModal === 'filter') {
        setFilterMask(modalPane, inputValue);
      }
      closeModal();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-slate-950 border-slate-700 text-slate-100 focus:border-blue-500'
      : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className={`w-full max-w-md rounded-lg border shadow-2xl overflow-hidden ${
          isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b text-xs font-semibold ${
            isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <span>{modalTitleMap[activeModal]}</span>
          <button type="button" onClick={closeModal} className="p-0.5 rounded opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-4 space-y-3 text-xs">
          {error && (
            <div className="p-2 rounded bg-red-500/20 border border-red-500/40 text-red-300">
              {error}
            </div>
          )}

          {(activeModal === 'newfile' || activeModal === 'rename') && (
            <div>
              <label className="block mb-1 font-medium">
                {activeModal === 'newfile'
                  ? 'New file name:'
                  : `Rename "${firstEntry?.name ?? ''}" to:`}
              </label>
              <input
                autoFocus
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className={inputCls}
                required
              />
            </div>
          )}

          {(activeModal === 'opendir' || activeModal === 'filter') && (
            <div>
              <label className="block mb-1 font-medium">
                {activeModal === 'opendir'
                  ? 'Directory path:'
                  : 'File mask (e.g. *.ts;*.rs or * for all):'}
              </label>
              <input
                autoFocus
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className={inputCls}
              />
            </div>
          )}

          {activeModal === 'delete' && (
            <div className="space-y-2">
              <p>
                Delete <strong>{targets.length}</strong> selected {isRemoteSftp ? 'remote ' : ''}item(s)?
              </p>
              <ul className={`max-h-24 overflow-y-auto text-[11px] font-mono p-2 rounded border ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                {targetEntries.map((entry) => (
                  <li key={entry.path} className="truncate">
                    {entry.name}
                  </li>
                ))}
              </ul>
              {!isRemoteSftp && (
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={useTrash}
                    onChange={(e) => setUseTrash(e.target.checked)}
                  />
                  <span>Move to Recycle Bin / Trash (uncheck for permanent delete)</span>
                </label>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={closeModal}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark ? 'border-slate-700 hover:bg-slate-800' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`px-3 py-1.5 rounded text-xs font-medium text-white ${
                activeModal === 'delete'
                  ? 'bg-red-600 hover:bg-red-500'
                  : 'bg-blue-600 hover:bg-blue-500'
              }`}
            >
              {busy ? 'Working...' : 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
