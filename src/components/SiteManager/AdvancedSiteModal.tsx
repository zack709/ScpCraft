import { useState } from 'react';
import { Folder, KeyRound, Network, Palette, Server, Settings2, Shield, X } from 'lucide-react';
import { useSiteStore } from '../../stores/useSiteStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

type AdvancedCategory =
  | 'directories'
  | 'environment'
  | 'connection'
  | 'authentication'
  | 'tunnel'
  | 'protocols'
  | 'note';

const COLOR_SWATCHES = [
  { label: 'Default', value: null },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Cyan', value: '#06b6d4' },
];

export function AdvancedSiteModal() {
  const { theme } = useWorkspaceStore();
  const {
    isAdvancedDialogOpen,
    closeAdvancedDialog,
    draftSite,
    draftPassphrase,
    draftTunnelPassword,
    updateDraft,
    setDraftPassphrase,
    setDraftTunnelPassword,
    isEditingSavedSite,
  } = useSiteStore();

  const [category, setCategory] = useState<AdvancedCategory>('directories');

  if (!isAdvancedDialogOpen) return null;

  const isDark = theme === 'dark';
  const editable = isEditingSavedSite;

  const inputCls = `w-full px-2 py-1 border text-xs outline-none ${
    isDark
      ? 'bg-[#1e1e1e] border-[#3f3f3f] text-[#e0e0e0] focus:border-[#4da3ff] disabled:opacity-60'
      : 'bg-white border-[#c0c0c0] text-[#1e1e1e] focus:border-[#0078d7] disabled:bg-slate-100 disabled:text-slate-500'
  }`;

  const groupCls = `border p-3 space-y-2.5 ${
    isDark ? 'border-[#3a3a3a] bg-[#222223]' : 'border-[#d0d0d0] bg-[#fafafa]'
  }`;

  const navItems: { id: AdvancedCategory; label: string; group: string; icon: React.ReactNode }[] = [
    { id: 'directories', label: 'Directories', group: 'Environment', icon: <Folder className="w-3.5 h-3.5 text-amber-400" /> },
    { id: 'environment', label: 'Environment', group: 'Environment', icon: <Settings2 className="w-3.5 h-3.5 text-sky-400" /> },
    { id: 'connection', label: 'Connection', group: 'Connection', icon: <Network className="w-3.5 h-3.5 text-emerald-400" /> },
    { id: 'authentication', label: 'Authentication', group: 'SSH', icon: <KeyRound className="w-3.5 h-3.5 text-amber-300" /> },
    { id: 'tunnel', label: 'Tunnel', group: 'SSH', icon: <Shield className="w-3.5 h-3.5 text-[#4da3ff]" /> },
    { id: 'protocols', label: 'FTP / S3 / WebDAV', group: 'Protocols', icon: <Server className="w-3.5 h-3.5 text-purple-400" /> },
    { id: 'note', label: 'Note & Color', group: 'Other', icon: <Palette className="w-3.5 h-3.5 text-pink-400" /> },
  ];

  const adv = draftSite.advanced;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 select-none"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeAdvancedDialog();
      }}
    >
      <div
        className={`w-[625px] max-w-full border shadow-2xl flex flex-col text-xs ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-[#f0f0f0] border-[#a0a0a0] text-[#1e1e1e]'
        }`}
      >
        {/* Title bar matching TSiteAdvancedDialog */}
        <div
          className={`flex items-center justify-between px-3 py-1.5 border-b ${
            isDark ? 'bg-[#1f1f1f] border-[#383838]' : 'bg-white border-[#d0d0d0]'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            <Settings2 className="w-3.5 h-3.5 text-[#4da3ff]" />
            <span>
              Advanced Site Settings{draftSite.name ? ` — ${draftSite.name}` : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={closeAdvancedDialog}
            className="opacity-70 hover:opacity-100 p-0.5"
            aria-label="Close Advanced Site Settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Split body: Category tree + Active page */}
        <div className="flex h-[395px] p-2.5 gap-2.5 min-h-0">
          {/* Left CategoryTreeView */}
          <div
            className={`w-44 shrink-0 border overflow-y-auto p-1 space-y-0.5 ${
              isDark ? 'bg-[#1e1e1e] border-[#3f3f3f]' : 'bg-white border-[#c8c8c8]'
            }`}
          >
            {navItems.map((item, idx) => {
              const prevGroup = idx > 0 ? navItems[idx - 1].group : null;
              const selected = category === item.id;
              return (
                <div key={item.id}>
                  {item.group !== prevGroup && (
                    <div
                      className={`px-1.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        isDark ? 'text-[#888888]' : 'text-slate-500'
                      }`}
                    >
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setCategory(item.id)}
                    className={`w-full flex items-center gap-1.5 px-2 py-1 text-left transition-colors ${
                      selected
                        ? 'bg-[#1e4b85] text-white'
                        : isDark
                        ? 'hover:bg-[#2d2d2d] text-[#dcdcdc]'
                        : 'hover:bg-[#e5f1fb] text-[#1e1e1e]'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Right PageControl Sheet */}
          <div className="flex-1 overflow-y-auto pr-0.5 space-y-3">
            {category === 'directories' && (
              <div className={groupCls}>
                <div className="font-semibold text-[11px] opacity-90">Directories</div>
                <div>
                  <label className="block mb-1 opacity-85">Remote directory:</label>
                  <input
                    type="text"
                    disabled={!editable}
                    value={adv.remoteDirectory}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: { ...s.advanced, remoteDirectory: e.target.value },
                      }))
                    }
                    placeholder="/var/www/html or /home/user"
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div>
                  <label className="block mb-1 opacity-85">Local directory:</label>
                  <input
                    type="text"
                    disabled={!editable}
                    value={adv.localDirectory}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: { ...s.advanced, localDirectory: e.target.value },
                      }))
                    }
                    placeholder="E:\Workspace\project"
                    className={`${inputCls} font-mono`}
                  />
                  <div className="text-[10px] opacity-65 mt-1">
                    Applied to Local Pane automatically when opening a Commander session.
                  </div>
                </div>
              </div>
            )}

            {category === 'environment' && (
              <div className={groupCls}>
                <div className="font-semibold text-[11px] opacity-90">Server environment</div>
                <div className="grid grid-cols-[1fr_140px] items-center gap-2">
                  <span>End-of-line characters (if not indicated by server):</span>
                  <select
                    disabled={!editable}
                    value={adv.eolStyle}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: { ...s.advanced, eolStyle: e.target.value },
                      }))
                    }
                    className={inputCls}
                  >
                    <option value="lf">LF (Unix)</option>
                    <option value="crlf">CR/LF (Windows)</option>
                  </select>
                </div>
                <div className="grid grid-cols-[1fr_140px] items-center gap-2">
                  <span>UTF-8 encoding for filenames:</span>
                  <select
                    disabled={!editable}
                    value={adv.utf8Encoding}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: { ...s.advanced, utf8Encoding: e.target.value },
                      }))
                    }
                    className={inputCls}
                  >
                    <option value="auto">Auto</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </div>
              </div>
            )}

            {category === 'connection' && (
              <div className={groupCls}>
                <div className="font-semibold text-[11px] opacity-90">Connection</div>
                <div className="grid grid-cols-[1fr_110px] items-center gap-2">
                  <span>Seconds between keepalives (0 to disable):</span>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    disabled={!editable}
                    value={adv.keepaliveIntervalSecs}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: {
                          ...s.advanced,
                          keepaliveIntervalSecs: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className={`${inputCls} text-right`}
                  />
                </div>
                <div className="grid grid-cols-[1fr_110px] items-center gap-2">
                  <span>Server response timeout (seconds):</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    disabled={!editable}
                    value={adv.timeoutSecs}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: {
                          ...s.advanced,
                          timeoutSecs: Math.max(1, Number(e.target.value) || 15),
                        },
                      }))
                    }
                    className={`${inputCls} text-right`}
                  />
                </div>
              </div>
            )}

            {category === 'authentication' && (
              <>
                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">Authentication options</div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={adv.useSshAgent}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: { ...s.advanced, useSshAgent: e.target.checked },
                        }))
                      }
                    />
                    <span>Attempt authentication using Pageant / SSH agent</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={adv.agentForwarding}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: { ...s.advanced, agentForwarding: e.target.checked },
                        }))
                      }
                    />
                    <span>Allow agent forwarding</span>
                  </label>
                </div>

                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">Authentication parameters</div>
                  <div>
                    <label className="block mb-1 opacity-85">
                      Private key file (.ppk / OpenSSH id_ed25519 / id_rsa):
                    </label>
                    <input
                      type="text"
                      disabled={!editable}
                      value={adv.privateKeyPath}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: { ...s.advanced, privateKeyPath: e.target.value },
                        }))
                      }
                      placeholder="C:\Users\name\.ssh\id_ed25519"
                      className={`${inputCls} font-mono`}
                    />
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">
                      Private key passphrase (stored in OS Keyring, omitted from sites.json):
                    </label>
                    <input
                      type="password"
                      disabled={!editable}
                      value={draftPassphrase}
                      onChange={(e) => setDraftPassphrase(e.target.value)}
                      placeholder={draftSite.hasPassphrase ? '•••••••• (saved in Keyring)' : ''}
                      className={inputCls}
                    />
                  </div>
                </div>
              </>
            )}

            {category === 'tunnel' && (
              <div className={groupCls}>
                <label className="flex items-center gap-2 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={adv.tunnel.enabled}
                    onChange={(e) =>
                      updateDraft((s) => ({
                        ...s,
                        advanced: {
                          ...s.advanced,
                          tunnel: { ...s.advanced.tunnel, enabled: e.target.checked },
                        },
                      }))
                    }
                  />
                  <span>Connect through SSH tunnel (Jump Host)</span>
                </label>

                <div className="grid grid-cols-[1fr_90px] gap-2 pt-1">
                  <div>
                    <label className="block mb-1 opacity-85">Tunnel Hostname:</label>
                    <input
                      type="text"
                      disabled={!editable || !adv.tunnel.enabled}
                      value={adv.tunnel.hostName}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: {
                            ...s.advanced,
                            tunnel: { ...s.advanced.tunnel, hostName: e.target.value },
                          },
                        }))
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">Port number:</label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      disabled={!editable || !adv.tunnel.enabled}
                      value={adv.tunnel.portNumber}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: {
                            ...s.advanced,
                            tunnel: {
                              ...s.advanced.tunnel,
                              portNumber: Math.max(1, Number(e.target.value) || 22),
                            },
                          },
                        }))
                      }
                      className={`${inputCls} text-right`}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block mb-1 opacity-85">Username:</label>
                    <input
                      type="text"
                      disabled={!editable || !adv.tunnel.enabled}
                      value={adv.tunnel.userName}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: {
                            ...s.advanced,
                            tunnel: { ...s.advanced.tunnel, userName: e.target.value },
                          },
                        }))
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">Tunnel Password:</label>
                    <input
                      type="password"
                      disabled={!editable || !adv.tunnel.enabled}
                      value={draftTunnelPassword}
                      onChange={(e) => setDraftTunnelPassword(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-[1fr_110px] gap-2">
                  <div>
                    <label className="block mb-1 opacity-85">Tunnel Private key file:</label>
                    <input
                      type="text"
                      disabled={!editable || !adv.tunnel.enabled}
                      value={adv.tunnel.privateKeyPath}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: {
                            ...s.advanced,
                            tunnel: { ...s.advanced.tunnel, privateKeyPath: e.target.value },
                          },
                        }))
                      }
                      className={`${inputCls} font-mono`}
                    />
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">Local port (0=auto):</label>
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      disabled={!editable || !adv.tunnel.enabled}
                      value={adv.tunnel.localPort}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: {
                            ...s.advanced,
                            tunnel: {
                              ...s.advanced.tunnel,
                              localPort: Math.max(0, Number(e.target.value) || 0),
                            },
                          },
                        }))
                      }
                      className={`${inputCls} text-right`}
                    />
                  </div>
                </div>
              </div>
            )}

            {category === 'protocols' && (
              <>
                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">FTP Options</div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={adv.ftpPassiveMode}
                      onChange={(e) =>
                        updateDraft((s) => ({
                          ...s,
                          advanced: { ...s.advanced, ftpPassiveMode: e.target.checked },
                        }))
                      }
                    />
                    <span>Passive mode (PASV)</span>
                  </label>
                </div>

                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">Amazon S3 Options</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block mb-1 opacity-85">Default region:</label>
                      <input
                        type="text"
                        disabled={!editable}
                        value={adv.s3Region}
                        onChange={(e) =>
                          updateDraft((s) => ({
                            ...s,
                            advanced: { ...s.advanced, s3Region: e.target.value },
                          }))
                        }
                        placeholder="us-east-1"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block mb-1 opacity-85">URL style:</label>
                      <select
                        disabled={!editable}
                        value={adv.s3UrlStyle}
                        onChange={(e) =>
                          updateDraft((s) => ({
                            ...s,
                            advanced: { ...s.advanced, s3UrlStyle: e.target.value },
                          }))
                        }
                        className={inputCls}
                      >
                        <option value="virtualHost">Virtual host</option>
                        <option value="path">Path</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">AWS Profile name:</label>
                    <input
                      type="text"
                      disabled={!editable}
                      value={draftSite.s3Profile}
                      onChange={(e) =>
                        updateDraft((s) => ({ ...s, s3Profile: e.target.value }))
                      }
                      placeholder="default"
                      className={inputCls}
                    />
                  </div>
                </div>
              </>
            )}

            {category === 'note' && (
              <div className={groupCls}>
                <div className="font-semibold text-[11px] opacity-90">Tab / Site Color & Note</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {COLOR_SWATCHES.map((sw) => {
                    const selected = draftSite.color === sw.value;
                    return (
                      <button
                        key={sw.label}
                        type="button"
                        disabled={!editable}
                        onClick={() => updateDraft((s) => ({ ...s, color: sw.value }))}
                        className={`px-2 py-0.5 border text-[11px] flex items-center gap-1.5 ${
                          selected
                            ? 'border-[#4da3ff] bg-[#1e4b85]/40'
                            : isDark
                            ? 'border-[#3f3f3f] hover:bg-[#333333]'
                            : 'border-[#c8c8c8] hover:bg-[#e5e5e5]'
                        }`}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full border border-black/30"
                          style={{ backgroundColor: sw.value ?? 'transparent' }}
                        />
                        {sw.label}
                      </button>
                    );
                  })}
                </div>
                <div>
                  <label className="block mb-1 opacity-85">Site Note:</label>
                  <textarea
                    rows={8}
                    disabled={!editable}
                    value={draftSite.note}
                    onChange={(e) => updateDraft((s) => ({ ...s, note: e.target.value }))}
                    className={`${inputCls} resize-none`}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className={`flex items-center justify-between px-3 py-2 border-t ${
            isDark ? 'bg-[#1f1f1f] border-[#383838]' : 'bg-[#e8e8e8] border-[#cccccc]'
          }`}
        >
          <span className="text-[11px] opacity-70">
            {editable
              ? 'Changes update the active draft; click Save in Site Manager to persist.'
              : 'Read-only preview — click Edit in Site Manager to modify.'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeAdvancedDialog}
              className="px-5 py-1 bg-[#1e4b85] hover:bg-[#255da3] text-white font-medium"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
