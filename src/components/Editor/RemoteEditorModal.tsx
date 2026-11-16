import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ExternalLink,
  FileCode2,
  Loader2,
  RefreshCw,
  Replace,
  Save,
  SaveAll,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { editorApi } from '../../services/phase5Api';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

const KEYWORDS_RE =
  /\b(const|let|var|function|return|if|else|elif|fi|then|for|while|switch|case|break|import|export|from|default|type|interface|pub|fn|struct|enum|impl|match|async|await|try|catch|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|true|false|null|None|Some|Ok|Err)\b/g;

function renderHighlightedLine(line: string, isDark: boolean) {
  const trimmed = line.trimStart();
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('--')
  ) {
    return (
      <span className={isDark ? 'text-emerald-400/90' : 'text-emerald-700'}>
        {line || ' '}
      </span>
    );
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  KEYWORDS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = KEYWORDS_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    parts.push(
      <span
        key={keyIdx++}
        className={isDark ? 'text-sky-400 font-semibold' : 'text-blue-700 font-semibold'}
      >
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }
  return parts.length > 0 ? parts : ' ';
}

export function RemoteEditorModal() {
  const {
    theme,
    rightPaneMode,
    openEditorFiles,
    editorDrafts,
    activeEditorDocId,
    isEditorModalOpen,
    setActiveEditorDocId,
    updateEditorDraft,
    updateEditorDocMeta,
    closeEditorDoc,
    closeEditorModal,
    refreshPane,
    addQueueLog,
  } = useWorkspaceStore();

  const isDark = theme === 'dark';
  const activeDoc =
    openEditorFiles.find((d) => d.docId === activeEditorDocId) ??
    openEditorFiles[0] ??
    null;

  const [encoding, setEncoding] = useState('UTF-8');
  const [lineEnding, setLineEnding] = useState('LF');
  const [wordWrap, setWordWrap] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>('Ready');
  const [externalCmd, setExternalCmd] = useState('');
  const [showFindBar, setShowFindBar] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [gotoLine, setGotoLine] = useState('');
  const [cursorInfo, setCursorInfo] = useState({ line: 1, col: 1, charCode: 0 });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (activeDoc) {
      setEncoding(activeDoc.encoding || 'UTF-8');
      setLineEnding(activeDoc.lineEnding || 'LF');
      setStatusMsg(
        activeDoc.watchingExternal
          ? `Watching external file: ${activeDoc.localTempPath}`
          : activeDoc.isRemote
          ? `Remote SFTP: ${activeDoc.path}`
          : `Local: ${activeDoc.path}`,
      );
    }
  }, [activeDoc?.docId, activeDoc?.encoding, activeDoc?.lineEnding, activeDoc?.watchingExternal]);

  const draft = activeDoc ? editorDrafts[activeDoc.docId] ?? activeDoc.content : '';
  const isDirty = activeDoc ? draft !== activeDoc.content : false;

  const lines = useMemo(() => draft.split('\n'), [draft]);

  const updateCursorFromElement = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const before = el.value.slice(0, pos);
    const split = before.split('\n');
    const line = split.length;
    const col = split[split.length - 1].length + 1;
    const charCode = pos < el.value.length ? el.value.charCodeAt(pos) : 0;
    setCursorInfo({ line, col, charCode });
  };

  const syncScroll = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    if (backdropRef.current) {
      backdropRef.current.scrollTop = ta.scrollTop;
      backdropRef.current.scrollLeft = ta.scrollLeft;
    }
  };

  const handleSave = async (targetDoc = activeDoc) => {
    if (!targetDoc) return;
    const text = editorDrafts[targetDoc.docId] ?? targetDoc.content;
    const enc = targetDoc.docId === activeDoc?.docId ? encoding : targetDoc.encoding;
    const eol = targetDoc.docId === activeDoc?.docId ? lineEnding : targetDoc.lineEnding;

    setSaving(true);
    setStatusMsg(`Saving ${targetDoc.fileName}...`);
    try {
      const res = await editorApi.saveFile({
        docId: targetDoc.docId,
        content: text,
        encoding: enc,
        lineEnding: eol,
      });
      updateEditorDocMeta(
        {
          ...targetDoc,
          content: text,
          encoding: enc,
          lineEnding: eol,
          size: res.bytesWritten,
          modifiedMs: res.savedAtMs,
        },
        true,
      );
      setStatusMsg(
        `Saved ${res.bytesWritten} bytes${res.isRemote ? ' to remote server' : ' to disk'}`,
      );
      addQueueLog({
        operation: 'copy',
        source: targetDoc.fileName,
        target: res.path,
        status: 'done',
        detail: `Saved ${targetDoc.fileName} (${res.bytesWritten} bytes)`,
      });
      if (res.isRemote && rightPaneMode === 'remote_sftp') {
        void refreshPane('right');
      } else if (!res.isRemote) {
        void refreshPane(targetDoc.pane === 'right' ? 'right' : 'left');
      }
    } catch (err) {
      setStatusMsg(`Save failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAll = async () => {
    for (const doc of openEditorFiles) {
      if ((editorDrafts[doc.docId] ?? doc.content) !== doc.content) {
        await handleSave(doc);
      }
    }
  };

  const handleReload = async () => {
    if (!activeDoc) return;
    setSaving(true);
    try {
      const reloaded = await editorApi.reloadFile(activeDoc.docId);
      updateEditorDocMeta(reloaded, true);
      setEncoding(reloaded.encoding);
      setLineEnding(reloaded.lineEnding);
      setStatusMsg(`Reloaded ${reloaded.fileName}`);
    } catch (err) {
      setStatusMsg(`Reload failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenExternal = async () => {
    if (!activeDoc) return;
    try {
      if (isDirty) {
        await handleSave(activeDoc);
      }
      const msg = await editorApi.openExternal(
        activeDoc.docId,
        externalCmd.trim() || null,
      );
      updateEditorDocMeta({ ...activeDoc, watchingExternal: true });
      setStatusMsg(msg);
      addQueueLog({
        operation: 'copy',
        source: activeDoc.path,
        target: 'External Editor Watch',
        status: 'done',
        detail: msg,
      });
    } catch (err) {
      setStatusMsg(`External launch error: ${String(err)}`);
    }
  };

  const handleFindNext = () => {
    const ta = textareaRef.current;
    if (!ta || !findQuery) return;
    const text = ta.value;
    const start = ta.selectionEnd ?? 0;
    let idx = text.toLowerCase().indexOf(findQuery.toLowerCase(), start);
    if (idx === -1) {
      idx = text.toLowerCase().indexOf(findQuery.toLowerCase(), 0);
    }
    if (idx >= 0) {
      ta.focus();
      ta.setSelectionRange(idx, idx + findQuery.length);
      updateCursorFromElement(ta);
      setStatusMsg(`Found "${findQuery}" at offset ${idx}`);
    } else {
      setStatusMsg(`"${findQuery}" not found`);
    }
  };

  const handleReplaceAll = () => {
    if (!activeDoc || !findQuery) return;
    const next = draft.split(findQuery).join(replaceQuery);
    updateEditorDraft(activeDoc.docId, next);
    setStatusMsg(`Replaced occurrences of "${findQuery}"`);
  };

  const handleGoToLine = () => {
    const num = Number.parseInt(gotoLine, 10);
    const ta = textareaRef.current;
    if (!ta || !Number.isFinite(num) || num < 1) return;
    const targetLine = Math.min(num, lines.length);
    let offset = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      offset += lines[i].length + 1;
    }
    ta.focus();
    ta.setSelectionRange(offset, offset);
    updateCursorFromElement(ta);
    ta.scrollTop = Math.max(0, (targetLine - 5) * 18);
    syncScroll();
  };

  useEffect(() => {
    if (!isEditorModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveAll();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFindBar(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setShowFindBar(true);
      } else if (e.key === 'F2') {
        e.preventDefault();
        void handleSave();
      } else if (e.key === 'F3') {
        e.preventDefault();
        handleFindNext();
      } else if (e.key === 'F5') {
        e.preventDefault();
        void handleReload();
      } else if (e.key === 'Escape') {
        closeEditorModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!isEditorModalOpen || !activeDoc) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
      <div
        className={`w-full max-w-5xl h-[84vh] flex flex-col border shadow-2xl ${
          isDark
            ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0]'
            : 'bg-[#f5f5f5] border-[#b5b5b5] text-[#1e1e1e]'
        }`}
      >
        {/* Title Bar */}
        <div
          className={`shrink-0 px-3 py-1.5 border-b flex items-center justify-between text-xs font-semibold ${
            isDark
              ? 'bg-[#252526] border-[#333333] text-white'
              : 'bg-[#e6e6e6] border-[#c8c8c8] text-[#1e1e1e]'
          }`}
        >
          <span className="flex items-center gap-2 truncate">
            <FileCode2 className="w-4 h-4 text-[#4da3ff]" />
            <span>
              ScpCraft Editor — {activeDoc.fileName}
              {isDirty ? ' *' : ''}
            </span>
            {activeDoc.watchingExternal && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-600/20 text-emerald-400 border border-emerald-500/40">
                External Watch Active
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeEditorModal}
              title="Minimize / Keep Open"
              className={`px-2 py-0.5 text-[11px] font-normal border ${
                isDark
                  ? 'border-[#444] hover:bg-[#333]'
                  : 'border-[#c0c0c0] bg-white hover:bg-slate-100'
              }`}
            >
              Hide
            </button>
            <button
              type="button"
              onClick={() => void closeEditorDoc(activeDoc.docId)}
              title="Close File"
              className="p-0.5 hover:text-red-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Document Tabs */}
        <div
          className={`shrink-0 flex items-center gap-0.5 px-1.5 pt-1 border-b overflow-x-auto text-[11px] ${
            isDark
              ? 'bg-[#202020] border-[#333333]'
              : 'bg-[#eaeaea] border-[#cccccc]'
          }`}
        >
          {openEditorFiles.map((doc) => {
            const selected = doc.docId === activeDoc.docId;
            const tabDirty = (editorDrafts[doc.docId] ?? doc.content) !== doc.content;
            return (
              <div
                key={doc.docId}
                className={`flex items-center gap-1.5 px-2.5 py-1 border-t border-x cursor-pointer max-w-[200px] ${
                  selected
                    ? isDark
                      ? 'bg-[#1e1e1e] border-[#3f3f3f] text-white font-medium'
                      : 'bg-white border-[#b5b5b5] text-black font-medium'
                    : isDark
                    ? 'bg-[#2a2a2a] border-transparent text-[#a8a8a8] hover:text-white'
                    : 'bg-[#dcdcdc] border-transparent text-[#444] hover:text-black'
                }`}
                onClick={() => setActiveEditorDocId(doc.docId)}
              >
                <span className="truncate">{doc.fileName}</span>
                {tabDirty && <span className="text-amber-400 font-bold">*</span>}
                {doc.watchingExternal && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeEditorDoc(doc.docId);
                  }}
                  className="hover:text-red-400 ml-1"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* TTBXToolbar */}
        <div
          className={`shrink-0 flex items-center flex-wrap gap-1 px-2 py-1 border-b text-[11px] ${
            isDark
              ? 'bg-[#252526] border-[#333333]'
              : 'bg-[#f0f0f0] border-[#cccccc]'
          }`}
        >
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="flex items-center gap-1 px-2 py-0.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-medium"
            title="Save & Upload (Ctrl+S / F2)"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Save
          </button>
          <button
            type="button"
            onClick={() => void handleSaveAll()}
            className={`flex items-center gap-1 px-2 py-0.5 border ${
              isDark
                ? 'border-[#3f3f3f] hover:bg-[#333]'
                : 'border-[#c8c8c8] bg-white hover:bg-slate-100'
            }`}
            title="Save All Open Documents (Ctrl+Shift+S)"
          >
            <SaveAll className="w-3.5 h-3.5" />
            Save All
          </button>
          <button
            type="button"
            onClick={() => void handleReload()}
            className={`flex items-center gap-1 px-2 py-0.5 border ${
              isDark
                ? 'border-[#3f3f3f] hover:bg-[#333]'
                : 'border-[#c8c8c8] bg-white hover:bg-slate-100'
            }`}
            title="Reload from Source (F5)"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reload
          </button>
          <button
            type="button"
            onClick={() => setShowFindBar((v) => !v)}
            className={`flex items-center gap-1 px-2 py-0.5 border ${
              showFindBar
                ? 'bg-[#1e4b85] text-white border-[#3b82f6]'
                : isDark
                ? 'border-[#3f3f3f] hover:bg-[#333]'
                : 'border-[#c8c8c8] bg-white hover:bg-slate-100'
            }`}
            title="Find / Replace (Ctrl+F / Ctrl+H)"
          >
            <Search className="w-3.5 h-3.5" />
            Find / Replace
          </button>
          <button
            type="button"
            onClick={() => setWordWrap((w) => !w)}
            className={`flex items-center gap-1 px-2 py-0.5 border ${
              wordWrap
                ? 'bg-[#1e4b85] text-white border-[#3b82f6]'
                : isDark
                ? 'border-[#3f3f3f] hover:bg-[#333]'
                : 'border-[#c8c8c8] bg-white hover:bg-slate-100'
            }`}
          >
            <WrapText className="w-3.5 h-3.5" />
            Wrap
          </button>

          <select
            aria-label="Encoding"
            value={encoding}
            onChange={(e) => setEncoding(e.target.value)}
            className={`h-6 px-1.5 border outline-none ${
              isDark
                ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0]'
                : 'bg-white border-[#c8c8c8]'
            }`}
          >
            <option value="UTF-8">UTF-8</option>
            <option value="UTF-8-BOM">UTF-8 (BOM)</option>
            <option value="Latin-1">Latin-1 (ANSI)</option>
          </select>

          <select
            aria-label="Line Ending"
            value={lineEnding}
            onChange={(e) => setLineEnding(e.target.value)}
            className={`h-6 px-1.5 border outline-none ${
              isDark
                ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0]'
                : 'bg-white border-[#c8c8c8]'
            }`}
          >
            <option value="LF">LF (Unix)</option>
            <option value="CRLF">CRLF (Windows)</option>
          </select>

          <div className="flex-1" />

          <input
            type="text"
            value={externalCmd}
            onChange={(e) => setExternalCmd(e.target.value)}
            placeholder="External cmd (e.g. code, blank = OS default)"
            className={`w-48 h-6 px-2 border text-[11px] outline-none ${
              isDark
                ? 'bg-[#1a1a1a] border-[#3f3f3f] text-[#e0e0e0]'
                : 'bg-white border-[#c8c8c8]'
            }`}
          />
          <button
            type="button"
            onClick={() => void handleOpenExternal()}
            className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
            title="Open local staged file in external editor and auto-upload on save"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open External & Watch
          </button>
        </div>

        {/* Optional Find / Replace / GoTo Strip */}
        {showFindBar && (
          <div
            className={`shrink-0 flex items-center flex-wrap gap-2 px-3 py-1.5 border-b text-[11px] ${
              isDark
                ? 'bg-[#252526] border-[#333333]'
                : 'bg-[#fafafa] border-[#cccccc]'
            }`}
          >
            <input
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              placeholder="Find text..."
              className={`px-2 py-0.5 border outline-none w-44 ${
                isDark ? 'bg-[#1a1a1a] border-[#3f3f3f]' : 'bg-white border-[#c8c8c8]'
              }`}
            />
            <button
              type="button"
              onClick={handleFindNext}
              className={`px-2 py-0.5 border ${
                isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#ccc] bg-white'
              }`}
            >
              Find Next (F3)
            </button>
            <input
              type="text"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              placeholder="Replace with..."
              className={`px-2 py-0.5 border outline-none w-40 ${
                isDark ? 'bg-[#1a1a1a] border-[#3f3f3f]' : 'bg-white border-[#c8c8c8]'
              }`}
            />
            <button
              type="button"
              onClick={handleReplaceAll}
              className={`flex items-center gap-1 px-2 py-0.5 border ${
                isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#ccc] bg-white'
              }`}
            >
              <Replace className="w-3 h-3" />
              Replace All
            </button>
            <span className="opacity-50">|</span>
            <input
              type="number"
              min={1}
              value={gotoLine}
              onChange={(e) => setGotoLine(e.target.value)}
              placeholder="Line #"
              className={`px-2 py-0.5 border outline-none w-20 ${
                isDark ? 'bg-[#1a1a1a] border-[#3f3f3f]' : 'bg-white border-[#c8c8c8]'
              }`}
            />
            <button
              type="button"
              onClick={handleGoToLine}
              className={`px-2 py-0.5 border ${
                isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#ccc] bg-white'
              }`}
            >
              Go To
            </button>
          </div>
        )}

        {/* Code Editor Viewport with Line Numbers & Syntax Highlight */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div
            ref={gutterRef}
            className={`w-12 shrink-0 overflow-hidden text-right pr-2 py-2 font-mono text-[12px] leading-[18px] select-none border-r ${
              isDark
                ? 'bg-[#1a1a1a] border-[#2d2d2d] text-[#6e7681]'
                : 'bg-[#f0f0f0] border-[#d0d0d0] text-[#777]'
            }`}
          >
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>

          <div
            className={`relative flex-1 min-w-0 overflow-hidden ${
              isDark ? 'bg-[#181818]' : 'bg-white'
            }`}
          >
            {!wordWrap && (
              <pre
                ref={backdropRef}
                aria-hidden="true"
                className={`absolute inset-0 m-0 p-2 font-mono text-[12px] leading-[18px] whitespace-pre overflow-hidden pointer-events-none ${
                  isDark ? 'text-[#d4d4d4]' : 'text-[#1e1e1e]'
                }`}
              >
                {lines.map((line, i) => (
                  <div key={i}>{renderHighlightedLine(line, isDark)}</div>
                ))}
              </pre>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              spellCheck={false}
              wrap={wordWrap ? 'soft' : 'off'}
              onScroll={syncScroll}
              onClick={(e) => updateCursorFromElement(e.currentTarget)}
              onKeyUp={(e) => updateCursorFromElement(e.currentTarget)}
              onChange={(e) => {
                updateEditorDraft(activeDoc.docId, e.target.value);
                updateCursorFromElement(e.currentTarget);
              }}
              className={`relative z-10 w-full h-full resize-none border-0 p-2 font-mono text-[12px] leading-[18px] outline-none bg-transparent scpcraft-scroll ${
                wordWrap
                  ? isDark
                    ? 'text-[#d4d4d4] whitespace-pre-wrap'
                    : 'text-[#1e1e1e] whitespace-pre-wrap'
                  : 'text-transparent whitespace-pre overflow-auto'
              }`}
              style={
                wordWrap
                  ? undefined
                  : { caretColor: isDark ? '#ffffff' : '#000000' }
              }
            />
          </div>
        </div>

        {/* WinSCP TEditorForm StatusBar */}
        <div
          className={`shrink-0 h-6 px-2 border-t flex items-center justify-between text-[11px] ${
            isDark
              ? 'bg-[#252526] border-[#333333] text-[#b0b0b0]'
              : 'bg-[#e6e6e6] border-[#c8c8c8] text-[#333333]'
          }`}
        >
          <div className="flex items-center gap-4">
            <span>
              Line: {cursorInfo.line}/{lines.length}
            </span>
            <span>Column: {cursorInfo.col}</span>
            <span>
              Character: {cursorInfo.charCode} (0x
              {cursorInfo.charCode.toString(16).toUpperCase().padStart(2, '0')})
            </span>
            <span>
              Encoding: {encoding} ({lineEnding})
            </span>
          </div>
          <div className="flex items-center gap-1.5 truncate max-w-md">
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="truncate">{statusMsg}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
