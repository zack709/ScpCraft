import { useEffect, useState } from 'react';
import { Play, Plus, Save, Terminal, Trash2, X } from 'lucide-react';
import { shellApi, type CustomCommandPreset } from '../../services/phase5Api';
import { getTargetEntriesForPane, useWorkspaceStore } from '../../stores/useWorkspaceStore';

function extractPromptTokens(pattern: string): { label: string; defaultVal: string }[] {
  const out: { label: string; defaultVal: string }[] = [];
  const re = /!\?([^?!]+)(?:\?([^!]*))?!/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    const label = m[1].trim();
    if (!out.some((x) => x.label === label)) {
      out.push({ label, defaultVal: (m[2] ?? '').trim() });
    }
  }
  return out;
}

export function CustomCommandModal() {
  const {
    theme,
    activeModal,
    modalPane,
    activeTabId,
    rightPaneMode,
    leftPane,
    rightPane,
    closeModal,
    toggleTerminalDrawer,
    appendTerminalConsole,
    addQueueLog,
  } = useWorkspaceStore();

  const isDark = theme === 'dark';
  const [presets, setPresets] = useState<CustomCommandPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeModal !== 'custom_commands') return;
    setError(null);
    void shellApi
      .listCustomCommands()
      .then((list) => {
        setPresets(list);
        if (list[0]) setSelectedId(list[0].id);
      })
      .catch((err) => setError(String(err)));
  }, [activeModal]);

  const activePreset = presets.find((p) => p.id === selectedId) ?? presets[0] ?? null;

  useEffect(() => {
    if (!activePreset) return;
    const tokens = extractPromptTokens(activePreset.command);
    const defaults: Record<string, string> = {};
    for (const t of tokens) {
      defaults[t.label] = t.defaultVal;
    }
    setPromptInputs(defaults);
  }, [activePreset?.id, activePreset?.command]);

  if (activeModal !== 'custom_commands') return null;

  const pane = modalPane === 'left' ? leftPane : rightPane;
  const targetEntries = getTargetEntriesForPane(pane);
  const targetNames = targetEntries.map((e) => e.name);
  const promptDefs = activePreset ? extractPromptTokens(activePreset.command) : [];

  const updateActive = (patch: Partial<CustomCommandPreset>) => {
    if (!activePreset) return;
    setPresets((prev) =>
      prev.map((p) => (p.id === activePreset.id ? { ...p, ...patch } : p)),
    );
  };

  const handleAddPreset = () => {
    const created: CustomCommandPreset = {
      id: `cc-${Date.now()}`,
      description: 'New Custom Command',
      command: 'ls -lh !/',
      isLocal: false,
      applyToDirectories: true,
      executeRecursively: false,
      showResultsInTerminal: true,
      copyResultsToClipboard: false,
      useRemoteFiles: true,
      shortcut: '',
    };
    setPresets((prev) => [...prev, created]);
    setSelectedId(created.id);
  };

  const handleDeletePreset = () => {
    if (!activePreset) return;
    setPresets((prev) => {
      const next = prev.filter((p) => p.id !== activePreset.id);
      if (next[0]) setSelectedId(next[0].id);
      return next;
    });
  };

  const handleSavePresets = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await shellApi.saveCustomCommands(presets);
      setPresets(saved);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async () => {
    if (!activePreset) return;
    setBusy(true);
    setError(null);
    try {
      await shellApi.saveCustomCommands(presets);
      const isRemoteTarget =
        !activePreset.isLocal &&
        (activePreset.useRemoteFiles || modalPane === 'right') &&
        rightPaneMode === 'remote_sftp';

      const cwd = isRemoteTarget
        ? rightPane.currentPath || '~'
        : leftPane.currentPath || pane.currentPath;

      const expanded = await shellApi.expandCustomCommand(
        activePreset.command,
        cwd,
        targetNames,
        promptInputs,
      );

      appendTerminalConsole(`[Custom: ${activePreset.description}] $ ${expanded}`);
      const res = isRemoteTarget
        ? await shellApi.execRemote({
            sessionId: activeTabId,
            command: expanded,
            cwd,
          })
        : await shellApi.execLocal(expanded, cwd);

      const combined = [res.stdout.trimEnd(), res.stderr.trimEnd()]
        .filter(Boolean)
        .join('\n');

      if (activePreset.showResultsInTerminal) {
        if (combined) appendTerminalConsole(combined);
        appendTerminalConsole(`[exit ${res.exitCode} in ${res.durationMs}ms]`);
        toggleTerminalDrawer(true);
      }

      if (activePreset.copyResultsToClipboard && combined) {
        await navigator.clipboard.writeText(combined);
      }

      addQueueLog({
        operation: 'copy',
        source: activePreset.description,
        target: isRemoteTarget ? 'Remote Exec' : 'Local Exec',
        status: res.exitCode === 0 ? 'done' : 'error',
        detail: `Exit ${res.exitCode}: ${expanded}`,
      });
      closeModal();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className={`w-full max-w-2xl border shadow-2xl text-xs ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-white border-[#c0c0c0] text-[#1e1e1e]'
        }`}
      >
        <div
          className={`flex items-center justify-between px-3 py-2 border-b font-semibold ${
            isDark
              ? 'bg-[#2d2d30] border-[#3f3f3f] text-white'
              : 'bg-[#f0f0f0] border-[#d0d0d0]'
          }`}
        >
          <span className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#4da3ff]" />
            Custom Commands (TCustomCommandDialog)
          </span>
          <button type="button" onClick={closeModal} className="hover:text-red-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-[200px_1fr] h-[380px]">
          {/* Preset List */}
          <div
            className={`border-r flex flex-col ${
              isDark ? 'border-[#3a3a3a] bg-[#1e1e1e]' : 'border-[#d8d8d8] bg-[#f8f8f8]'
            }`}
          >
            <div className="flex-1 overflow-y-auto scpcraft-scroll p-1 space-y-0.5">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full px-2 py-1.5 text-left truncate rounded-sm ${
                    p.id === activePreset?.id
                      ? 'bg-[#1e4b85] text-white font-medium'
                      : isDark
                      ? 'hover:bg-[#2a2d2e]'
                      : 'hover:bg-[#e5e5e5]'
                  }`}
                >
                  {p.description}
                </button>
              ))}
            </div>
            <div
              className={`p-1.5 border-t flex items-center gap-1 ${
                isDark ? 'border-[#333333]' : 'border-[#d8d8d8]'
              }`}
            >
              <button
                type="button"
                onClick={handleAddPreset}
                className="flex-1 flex items-center justify-center gap-1 py-1 border border-slate-600/40 hover:bg-slate-600/20"
              >
                <Plus className="w-3 h-3" />
                Add
              </button>
              <button
                type="button"
                disabled={!activePreset}
                onClick={handleDeletePreset}
                className="px-2 py-1 border border-slate-600/40 text-red-400 hover:bg-red-900/20"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Preset Editor & Pattern Runner */}
          <div className="p-3 overflow-y-auto space-y-3 scpcraft-scroll">
            {activePreset && (
              <>
                <div>
                  <label className="block mb-1 font-medium">Description:</label>
                  <input
                    type="text"
                    value={activePreset.description}
                    onChange={(e) => updateActive({ description: e.target.value })}
                    className={`w-full px-2 py-1 border outline-none ${
                      isDark
                        ? 'bg-[#1a1a1a] border-[#3f3f3f] text-white'
                        : 'bg-white border-[#c8c8c8]'
                    }`}
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-medium">Custom command:</label>
                    <div className="flex items-center gap-1 text-[10px]">
                      {['!', '!/', '!&', '!?Prompt?default!'].map((tok) => (
                        <button
                          key={tok}
                          type="button"
                          onClick={() =>
                            updateActive({
                              command: `${activePreset.command} ${tok}`.trim(),
                            })
                          }
                          className={`px-1.5 py-0.5 font-mono border ${
                            isDark
                              ? 'bg-[#2a2d2e] border-[#454545] hover:bg-[#3a3d3e]'
                              : 'bg-slate-100 border-slate-300 hover:bg-slate-200'
                          }`}
                        >
                          {tok}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input
                    type="text"
                    value={activePreset.command}
                    onChange={(e) => updateActive({ command: e.target.value })}
                    className={`w-full px-2 py-1 border font-mono outline-none ${
                      isDark
                        ? 'bg-[#1a1a1a] border-[#3f3f3f] text-white'
                        : 'bg-white border-[#c8c8c8]'
                    }`}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      checked={!activePreset.isLocal}
                      onChange={() => updateActive({ isLocal: false })}
                    />
                    Remote command
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      checked={activePreset.isLocal}
                      onChange={() => updateActive({ isLocal: true })}
                    />
                    Local command
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activePreset.applyToDirectories}
                      onChange={(e) =>
                        updateActive({ applyToDirectories: e.target.checked })
                      }
                    />
                    Apply to directories
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activePreset.showResultsInTerminal}
                      onChange={(e) =>
                        updateActive({ showResultsInTerminal: e.target.checked })
                      }
                    />
                    Show results in terminal
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activePreset.copyResultsToClipboard}
                      onChange={(e) =>
                        updateActive({ copyResultsToClipboard: e.target.checked })
                      }
                    />
                    Copy results to clipboard
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activePreset.useRemoteFiles}
                      onChange={(e) =>
                        updateActive({ useRemoteFiles: e.target.checked })
                      }
                    />
                    Use remote files
                  </label>
                </div>

                {promptDefs.length > 0 && (
                  <div
                    className={`p-2 border space-y-1.5 ${
                      isDark
                        ? 'bg-[#1a1a1a] border-[#3a3a3a]'
                        : 'bg-slate-50 border-slate-300'
                    }`}
                  >
                    <div className="font-semibold text-[11px] text-[#4da3ff]">
                      Command Parameters:
                    </div>
                    {promptDefs.map((pd) => (
                      <div key={pd.label} className="flex items-center gap-2">
                        <span className="w-32 truncate">{pd.label}:</span>
                        <input
                          type="text"
                          value={promptInputs[pd.label] ?? pd.defaultVal}
                          onChange={(e) =>
                            setPromptInputs((prev) => ({
                              ...prev,
                              [pd.label]: e.target.value,
                            }))
                          }
                          className={`flex-1 px-2 py-0.5 border font-mono outline-none ${
                            isDark
                              ? 'bg-[#252526] border-[#454545] text-white'
                              : 'bg-white border-slate-300'
                          }`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {error && (
                  <div className="p-2 bg-red-950/50 border border-red-600/60 text-red-300">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div
          className={`flex items-center justify-between px-3 py-2 border-t ${
            isDark
              ? 'bg-[#2d2d30] border-[#3f3f3f]'
              : 'bg-[#f0f0f0] border-[#d0d0d0]'
          }`}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSavePresets()}
            className={`flex items-center gap-1 px-3 py-1 border ${
              isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#c0c0c0] bg-white'
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            Save Presets
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeModal}
              className={`px-3 py-1 border ${
                isDark ? 'border-[#444] hover:bg-[#333]' : 'border-[#c0c0c0] bg-white'
              }`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !activePreset}
              onClick={() => void handleRun()}
              className="flex items-center gap-1 px-3 py-1 bg-[#0284c7] hover:bg-[#0369a1] text-white font-medium"
            >
              <Play className="w-3.5 h-3.5" />
              Execute Command
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
