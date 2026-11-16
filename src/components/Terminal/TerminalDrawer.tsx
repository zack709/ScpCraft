import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  FolderSync,
  Play,
  Power,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { shellApi } from '../../services/phase5Api';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

interface AnsiLineSpan {
  text: string;
  fgClass: string;
}

const ANSI_FG_COLORS: Record<number, string> = {
  30: 'text-slate-900',
  31: 'text-red-400',
  32: 'text-emerald-400',
  33: 'text-amber-300',
  34: 'text-sky-400',
  35: 'text-purple-400',
  36: 'text-cyan-400',
  37: 'text-slate-100',
  90: 'text-slate-400',
  91: 'text-red-300',
  92: 'text-emerald-300',
  93: 'text-amber-200',
  94: 'text-sky-300',
  95: 'text-purple-300',
  96: 'text-cyan-300',
  97: 'text-white',
};

function stripOscAndControlNoise(raw: string): string {
  // Remove OSC sequences (\x1b]...(\x07|\x1b\\))
  return raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function parseAnsiScreenLines(buffer: string): AnsiLineSpan[][] {
  const clean = stripOscAndControlNoise(buffer);
  const lines: AnsiLineSpan[][] = [[]];
  let currentFg = 'text-slate-100';
  let curText = '';
  let lineIdx = 0;

  const flushCur = () => {
    if (!curText) return;
    while (lines.length <= lineIdx) lines.push([]);
    lines[lineIdx].push({ text: curText, fgClass: currentFg });
    curText = '';
  };

  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '\x1b' && clean[i + 1] === '[') {
      flushCur();
      let j = i + 2;
      while (j < clean.length && clean[j] >= '\x20' && clean[j] <= '\x3f') {
        j++;
      }
      const cmd = clean[j] ?? '';
      const params = clean.slice(i + 2, j);
      if (cmd === 'm') {
        for (const p of params.split(';')) {
          const code = Number.parseInt(p || '0', 10);
          if (code === 0 || code === 39) currentFg = 'text-slate-100';
          else if (ANSI_FG_COLORS[code]) currentFg = ANSI_FG_COLORS[code];
        }
      } else if (cmd === 'J' && (params === '2' || params === '3')) {
        lines.splice(0, lines.length, []);
        lineIdx = 0;
      } else if (cmd === 'K') {
        lines[lineIdx] = [];
      }
      i = j + 1;
      continue;
    }

    if (ch === '\r') {
      flushCur();
      if (clean[i + 1] === '\n') {
        lineIdx++;
        while (lines.length <= lineIdx) lines.push([]);
        i += 2;
      } else {
        lines[lineIdx] = [];
        i++;
      }
      continue;
    }

    if (ch === '\n') {
      flushCur();
      lineIdx++;
      while (lines.length <= lineIdx) lines.push([]);
      i++;
      continue;
    }

    if (ch === '\x08' || ch === '\x7f') {
      if (curText.length > 0) {
        curText = curText.slice(0, -1);
      } else if (lines[lineIdx] && lines[lineIdx].length > 0) {
        const last = lines[lineIdx][lines[lineIdx].length - 1];
        if (last.text.length > 0) last.text = last.text.slice(0, -1);
      }
      i++;
      continue;
    }

    if (ch === '\t') {
      curText += '    ';
      i++;
      continue;
    }

    if (ch >= ' ' || ch > '\x7f') {
      curText += ch;
    }
    i++;
  }
  flushCur();
  return lines.slice(-500);
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\"'\"'")}'`;
}

export function TerminalDrawer() {
  const {
    theme,
    activePane,
    rightPaneMode,
    activeTabId,
    leftPane,
    rightPane,
    showTerminalDrawer,
    toggleTerminalDrawer,
    commandHistory,
    terminalConsoleLogs,
    appendTerminalConsole,
    clearTerminalConsole,
    runCommandInput,
  } = useWorkspaceStore();

  const isDark = theme === 'dark';
  const [tab, setTab] = useState<'pty' | 'console'>(
    rightPaneMode === 'remote_sftp' ? 'pty' : 'console',
  );
  const [ptyRawOutput, setPtyRawOutput] = useState<string>('');
  const [ptyActive, setPtyActive] = useState(false);
  const [ptyError, setPtyError] = useState<string | null>(null);
  const [consoleCmd, setConsoleCmd] = useState('');
  const [consoleBusy, setConsoleBusy] = useState(false);

  const ptyScreenRef = useRef<HTMLDivElement>(null);
  const consoleOutputRef = useRef<HTMLPreElement>(null);

  const activeSessionId = activeTabId;
  const remoteCwd = rightPaneMode === 'remote_sftp' ? rightPane.currentPath || '~' : null;
  const activeCwd =
    activePane === 'right' && rightPaneMode === 'remote_sftp'
      ? rightPane.currentPath
      : (activePane === 'left' ? leftPane.currentPath : rightPane.currentPath) || '';

  useEffect(() => {
    let unlistenOut: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;

    void shellApi
      .onPtyOutput((ev) => {
        if (ev.sessionId === activeSessionId) {
          setPtyRawOutput((prev) => (prev + ev.data).slice(-120_000));
        }
      })
      .then((fn) => {
        unlistenOut = fn;
      })
      .catch(() => undefined);

    void shellApi
      .onPtyClosed((ev) => {
        if (ev.sessionId === activeSessionId) {
          setPtyActive(false);
          setPtyRawOutput((prev) =>
            `${prev}\r\n[PTY closed${ev.exitCode !== null ? ` (exit ${ev.exitCode})` : ''}]\r\n`,
          );
        }
      })
      .then((fn) => {
        unlistenClosed = fn;
      })
      .catch(() => undefined);

    return () => {
      if (unlistenOut) unlistenOut();
      if (unlistenClosed) unlistenClosed();
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (ptyScreenRef.current) {
      ptyScreenRef.current.scrollTop = ptyScreenRef.current.scrollHeight;
    }
  }, [ptyRawOutput, showTerminalDrawer]);

  useEffect(() => {
    if (consoleOutputRef.current) {
      consoleOutputRef.current.scrollTop = consoleOutputRef.current.scrollHeight;
    }
  }, [terminalConsoleLogs]);

  // ResizeObserver -> sync PTY cols/rows cleanly
  useEffect(() => {
    if (!showTerminalDrawer || tab !== 'pty' || !ptyActive) return;
    const el = ptyScreenRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cols = Math.max(20, Math.floor(entry.contentRect.width / 7.4));
        const rows = Math.max(5, Math.floor(entry.contentRect.height / 16));
        void shellApi.ptyResize(activeSessionId, cols, rows).catch(() => undefined);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTerminalDrawer, tab, ptyActive, activeSessionId]);

  const startPty = async () => {
    if (rightPaneMode !== 'remote_sftp') {
      setPtyError('Connect to an SFTP server first to open an interactive SSH PTY.');
      return;
    }
    setPtyError(null);
    try {
      const rect = ptyScreenRef.current?.getBoundingClientRect();
      const cols = rect ? Math.max(40, Math.floor(rect.width / 7.4)) : 100;
      const rows = rect ? Math.max(10, Math.floor(rect.height / 16)) : 24;
      await shellApi.ptyOpen({
        sessionId: activeSessionId,
        cwd: remoteCwd,
        cols,
        rows,
      });
      setPtyActive(true);
      setTimeout(() => ptyScreenRef.current?.focus(), 60);
    } catch (err) {
      setPtyError(String(err));
    }
  };

  useEffect(() => {
    if (showTerminalDrawer && rightPaneMode === 'remote_sftp' && tab === 'pty' && !ptyActive) {
      void startPty();
    }
  }, [showTerminalDrawer, rightPaneMode, tab]);

  const parsedLines = useMemo(() => parseAnsiScreenLines(ptyRawOutput), [ptyRawOutput]);

  if (!showTerminalDrawer) return null;

  const handlePtyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!ptyActive) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      void shellApi.ptyWrite(activeSessionId, '\t');
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() !== 'v' && e.key.toLowerCase() !== 'c') {
      const upper = e.key.toUpperCase();
      if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
        e.preventDefault();
        const code = upper.charCodeAt(0) - 64;
        void shellApi.ptyWrite(activeSessionId, String.fromCharCode(code));
        return;
      }
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      const sel = window.getSelection()?.toString() ?? '';
      if (!sel) {
        e.preventDefault();
        void shellApi.ptyWrite(activeSessionId, '\x03');
      }
      return;
    }

    let seq: string | null = null;
    if (e.key === 'Enter') seq = '\r';
    else if (e.key === 'Backspace') seq = '\x7f';
    else if (e.key === 'Escape') seq = '\x1b';
    else if (e.key === 'ArrowUp') seq = '\x1b[A';
    else if (e.key === 'ArrowDown') seq = '\x1b[B';
    else if (e.key === 'ArrowRight') seq = '\x1b[C';
    else if (e.key === 'ArrowLeft') seq = '\x1b[D';
    else if (e.key === 'Home') seq = '\x1b[H';
    else if (e.key === 'End') seq = '\x1b[F';
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      seq = e.key;
    }

    if (seq !== null) {
      e.preventDefault();
      void shellApi.ptyWrite(activeSessionId, seq);
    }
  };

  const handleExecuteConsole = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = consoleCmd.trim();
    if (!cmd) return;
    setConsoleBusy(true);
    try {
      runCommandInput(cmd);
      setConsoleCmd('');
    } finally {
      setConsoleBusy(false);
    }
  };

  return (
    <div
      className={`shrink-0 h-60 border-t flex flex-col ${
        isDark
          ? 'bg-[#1a1a1a] border-[#333333] text-[#e0e0e0]'
          : 'bg-[#f4f4f4] border-[#c8c8c8] text-[#1e1e1e]'
      }`}
    >
      {/* Header Bar */}
      <div
        className={`shrink-0 px-2.5 py-1 border-b flex items-center justify-between text-[11px] ${
          isDark
            ? 'bg-[#252526] border-[#333333]'
            : 'bg-[#e6e6e6] border-[#cccccc]'
        }`}
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-semibold">Terminal & Console (Ctrl+T)</span>
          <div className="flex items-center border rounded overflow-hidden ml-2 border-slate-600/40">
            <button
              type="button"
              onClick={() => setTab('pty')}
              className={`px-2 py-0.5 ${
                tab === 'pty'
                  ? 'bg-[#1e4b85] text-white font-medium'
                  : isDark
                  ? 'hover:bg-[#333]'
                  : 'hover:bg-slate-200'
              }`}
            >
              SSH Interactive PTY
            </button>
            <button
              type="button"
              onClick={() => setTab('console')}
              className={`px-2 py-0.5 ${
                tab === 'console'
                  ? 'bg-[#1e4b85] text-white font-medium'
                  : isDark
                  ? 'hover:bg-[#333]'
                  : 'hover:bg-slate-200'
              }`}
            >
              Command Console
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {tab === 'pty' && (
            <>
              <button
                type="button"
                disabled={!ptyActive || !remoteCwd}
                onClick={() => {
                  if (remoteCwd) {
                    void shellApi.ptyWrite(activeSessionId, `cd ${shellQuote(remoteCwd)}\r`);
                  }
                }}
                className={`flex items-center gap-1 px-2 py-0.5 border disabled:opacity-40 ${
                  isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#ccc] bg-white'
                }`}
                title="cd into current right pane directory"
              >
                <FolderSync className="w-3 h-3 text-sky-400" />
                Sync CWD
              </button>
              <button
                type="button"
                onClick={() => {
                  if (ptyActive) {
                    void shellApi.ptyClose(activeSessionId);
                    setPtyActive(false);
                  } else {
                    void startPty();
                  }
                }}
                className={`flex items-center gap-1 px-2 py-0.5 border ${
                  ptyActive
                    ? 'border-red-500/50 text-red-300 hover:bg-red-900/30'
                    : 'border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/30'
                }`}
              >
                <Power className="w-3 h-3" />
                {ptyActive ? 'Disconnect PTY' : 'Start PTY'}
              </button>
            </>
          )}
          {tab === 'console' && (
            <>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(terminalConsoleLogs.join('\n'));
                }}
                className={`flex items-center gap-1 px-2 py-0.5 border ${
                  isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#ccc] bg-white'
                }`}
              >
                <Copy className="w-3 h-3" />
                Copy
              </button>
              <button
                type="button"
                onClick={clearTerminalConsole}
                className={`flex items-center gap-1 px-2 py-0.5 border ${
                  isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#ccc] bg-white'
                }`}
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => toggleTerminalDrawer(false)}
            className="p-0.5 hover:text-red-400 ml-1"
            title="Close Terminal Drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tab Body */}
      {tab === 'pty' ? (
        <div
          ref={ptyScreenRef}
          tabIndex={0}
          onKeyDown={handlePtyKeyDown}
          onPaste={(e) => {
            if (!ptyActive) return;
            const pasted = e.clipboardData.getData('text');
            if (pasted) {
              e.preventDefault();
              void shellApi.ptyWrite(activeSessionId, pasted);
            }
          }}
          className="flex-1 bg-[#0c0e14] text-slate-100 font-mono text-[12px] leading-[16px] p-2 overflow-y-auto scpcraft-scroll outline-none cursor-text"
        >
          {ptyError && (
            <div className="mb-2 px-2 py-1 bg-amber-950/60 border border-amber-600/50 text-amber-300 text-xs flex items-center justify-between">
              <span>{ptyError}</span>
              <button
                type="button"
                onClick={() => setTab('console')}
                className="underline font-medium"
              >
                Switch to Local/Remote Command Console
              </button>
            </div>
          )}
          {parsedLines.length === 0 || (parsedLines.length === 1 && parsedLines[0].length === 0) ? (
            <div className="text-slate-400">
              {ptyActive
                ? 'SSH PTY ready. Type commands below...'
                : 'Click "Start PTY" when connected via SFTP, or use "Command Console" for local/remote commands.'}
            </div>
          ) : (
            parsedLines.map((spans, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-all min-h-[16px]">
                {spans.map((sp, j) => (
                  <span key={j} className={sp.fgClass}>
                    {sp.text}
                  </span>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <form
            onSubmit={(e) => void handleExecuteConsole(e)}
            className={`shrink-0 px-3 py-1.5 border-b flex items-center gap-2 text-[11px] ${
              isDark
                ? 'bg-[#202020] border-[#333333]'
                : 'bg-[#fafafa] border-[#d0d0d0]'
            }`}
          >
            <span className="font-medium shrink-0">Enter command:</span>
            <input
              type="text"
              list="scpcraft-console-history"
              value={consoleCmd}
              onChange={(e) => setConsoleCmd(e.target.value)}
              placeholder={
                activePane === 'right' && rightPaneMode === 'remote_sftp'
                  ? 'ls -la, df -h, uname -a ...'
                  : 'dir, git status, echo hello ...'
              }
              className={`flex-1 px-2 py-0.5 border font-mono text-xs outline-none ${
                isDark
                  ? 'bg-[#141414] border-[#3f3f3f] text-white focus:border-[#4da3ff]'
                  : 'bg-white border-[#c0c0c0] focus:border-[#0078d7]'
              }`}
            />
            <datalist id="scpcraft-console-history">
              {commandHistory.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={consoleBusy}
              className="flex items-center gap-1 px-2.5 py-0.5 bg-[#0284c7] hover:bg-[#0369a1] text-white font-medium"
            >
              <Play className="w-3 h-3" />
              Execute
            </button>
            <span className="text-[10px] font-mono opacity-75 truncate max-w-xs">
              CWD: {activeCwd || '~'}
            </span>
          </form>
          <div
            className={`shrink-0 px-3 py-0.5 text-[10px] flex items-center gap-1.5 border-b ${
              isDark
                ? 'bg-amber-950/30 border-[#333333] text-amber-300/90'
                : 'bg-amber-50 border-[#e0e0e0] text-amber-800'
            }`}
          >
            <AlertTriangle className="w-3 h-3 shrink-0" />
            Do not execute commands that require user-input or data transfer in non-interactive Console mode.
          </div>
          <pre
            ref={consoleOutputRef}
            onClick={() => appendTerminalConsole}
            className="flex-1 m-0 p-2 bg-[#0c0e14] text-slate-200 font-mono text-[11px] overflow-auto scpcraft-scroll whitespace-pre-wrap"
          >
            {terminalConsoleLogs.length === 0
              ? 'No command output yet.'
              : terminalConsoleLogs.join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
}
