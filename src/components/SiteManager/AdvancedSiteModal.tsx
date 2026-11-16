import { useState } from 'react';
import { Folder, FolderOpen, KeyRound, Network, Palette, Server, Settings2, Shield, X } from 'lucide-react';
import { translate, type TranslationKey } from '../../i18n';
import { siteApi } from '../../services/siteApi';
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

const COLOR_SWATCHES: { labelKey: TranslationKey; value: string | null }[] = [
  { labelKey: 'adv.color.default', value: null },
  { labelKey: 'adv.color.blue', value: '#3b82f6' },
  { labelKey: 'adv.color.green', value: '#22c55e' },
  { labelKey: 'adv.color.amber', value: '#f59e0b' },
  { labelKey: 'adv.color.red', value: '#ef4444' },
  { labelKey: 'adv.color.purple', value: '#a855f7' },
  { labelKey: 'adv.color.cyan', value: '#06b6d4' },
];

export function AdvancedSiteModal() {
  const { theme, locale } = useWorkspaceStore();
  const t = (key: TranslationKey) => translate(locale, key);
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
    { id: 'directories', label: t('adv.nav.directories'), group: t('adv.group.env'), icon: <Folder className="w-3.5 h-3.5 text-amber-400" /> },
    { id: 'environment', label: t('adv.nav.environment'), group: t('adv.group.env'), icon: <Settings2 className="w-3.5 h-3.5 text-sky-400" /> },
    { id: 'connection', label: t('adv.nav.connection'), group: t('adv.group.conn'), icon: <Network className="w-3.5 h-3.5 text-emerald-400" /> },
    { id: 'authentication', label: t('adv.nav.authentication'), group: t('adv.group.ssh'), icon: <KeyRound className="w-3.5 h-3.5 text-amber-300" /> },
    { id: 'tunnel', label: t('adv.nav.tunnel'), group: t('adv.group.ssh'), icon: <Shield className="w-3.5 h-3.5 text-[#4da3ff]" /> },
    { id: 'protocols', label: t('adv.nav.protocols'), group: t('adv.group.proto'), icon: <Server className="w-3.5 h-3.5 text-purple-400" /> },
    { id: 'note', label: t('adv.nav.note'), group: t('adv.group.other'), icon: <Palette className="w-3.5 h-3.5 text-pink-400" /> },
  ];

  const adv = draftSite.advanced;

  const browseBtnCls = `px-2.5 py-1 border text-xs whitespace-nowrap inline-flex items-center gap-1 shrink-0 transition-colors ${
    isDark
      ? 'bg-[#2d2d30] border-[#454545] text-[#e0e0e0] hover:bg-[#3a3a3e] disabled:opacity-45 disabled:pointer-events-none'
      : 'bg-[#e1e1e1] border-[#adadad] text-[#1e1e1e] hover:bg-[#e5f1fb] hover:border-[#0078d7] disabled:opacity-45 disabled:pointer-events-none'
  }`;

  const handleBrowseKey = async (target: 'main' | 'tunnel') => {
    const picked = await siteApi.pickPrivateKeyFile();
    if (!picked) return;
    if (target === 'main') {
      updateDraft((s) => ({
        ...s,
        advanced: { ...s.advanced, privateKeyPath: picked },
      }));
    } else {
      updateDraft((s) => ({
        ...s,
        advanced: {
          ...s.advanced,
          tunnel: { ...s.advanced.tunnel, privateKeyPath: picked },
        },
      }));
    }
  };

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
              {t('adv.title')}{draftSite.name ? ` — ${draftSite.name}` : ''}
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
                <div className="font-semibold text-[11px] opacity-90">{t('adv.nav.directories')}</div>
                <div>
                  <label className="block mb-1 opacity-85">{t('adv.remoteDir')}</label>
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
                  <label className="block mb-1 opacity-85">{t('adv.localDir')}</label>
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
                    {t('adv.localDirHint')}
                  </div>
                </div>
              </div>
            )}

            {category === 'environment' && (
              <>
                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">{t('adv.serverEnv')}</div>
                  <div className="grid grid-cols-[1fr_140px] items-center gap-2">
                    <span>{t('adv.eolLabel')}</span>
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
                    <span>{t('adv.utf8Label')}</span>
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
                      <option value="auto">{t('adv.utf8Auto')}</option>
                      <option value="on">{t('adv.utf8On')}</option>
                      <option value="off">{t('adv.utf8Off')}</option>
                    </select>
                  </div>
                </div>

                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">{t('adv.shellSection')}</div>
                  {(() => {
                    const presets = ['', '/bin/bash', '/bin/ksh', '/bin/sh', 'sudo su -'];
                    const currentShell = adv.shell ?? '';
                    const isPreset = presets.includes(currentShell);
                    return (
                      <div className="space-y-2">
                        <div className="grid grid-cols-[1fr_200px] items-center gap-2">
                          <span>{t('adv.shellLabel')}</span>
                          <select
                            disabled={!editable}
                            value={isPreset ? currentShell : '__custom__'}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === '__custom__') {
                                if (isPreset) {
                                  updateDraft((s) => ({
                                    ...s,
                                    advanced: { ...s.advanced, shell: 'sudo -i' },
                                  }));
                                }
                              } else {
                                updateDraft((s) => ({
                                  ...s,
                                  advanced: { ...s.advanced, shell: val },
                                }));
                              }
                            }}
                            className={inputCls}
                          >
                            <option value="">{t('adv.shellDefault')}</option>
                            <option value="/bin/bash">/bin/bash</option>
                            <option value="/bin/ksh">/bin/ksh</option>
                            <option value="/bin/sh">/bin/sh</option>
                            <option value="sudo su -">sudo su -</option>
                            <option value="__custom__">{t('adv.shellCustom')}</option>
                          </select>
                        </div>
                        {!isPreset && (
                          <input
                            type="text"
                            disabled={!editable}
                            value={currentShell}
                            onChange={(e) =>
                              updateDraft((s) => ({
                                ...s,
                                advanced: { ...s.advanced, shell: e.target.value },
                              }))
                            }
                            placeholder="sudo su -"
                            className={`${inputCls} font-mono`}
                          />
                        )}
                        <div className="text-[10px] opacity-65">
                          {t('adv.shellHint')}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </>
            )}

            {category === 'connection' && (
              <div className={groupCls}>
                <div className="font-semibold text-[11px] opacity-90">{t('adv.nav.connection')}</div>
                <div className="grid grid-cols-[1fr_110px] items-center gap-2">
                  <span>{t('adv.keepaliveSecs')}</span>
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
                  <span>{t('adv.timeoutSecs')}</span>
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
                  <div className="font-semibold text-[11px] opacity-90">{t('adv.authOptions')}</div>
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
                    <span>{t('adv.useSshAgent')}</span>
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
                    <span>{t('adv.agentForwarding')}</span>
                  </label>
                </div>

                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">{t('adv.authParams')}</div>
                  <div>
                    <label className="block mb-1 opacity-85">
                      {t('adv.privateKeyFile')}
                    </label>
                    <div className="flex items-center gap-1.5">
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
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() => void handleBrowseKey('main')}
                        className={browseBtnCls}
                        title={t('adv.browseFile')}
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t('adv.browseFile')}</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">
                      {t('adv.passphrase')}
                    </label>
                    <input
                      type="password"
                      disabled={!editable}
                      value={draftPassphrase}
                      onChange={(e) => setDraftPassphrase(e.target.value)}
                      placeholder={draftSite.hasPassphrase ? t('adv.savedInKeyring') : ''}
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
                  <span>{t('adv.tunnelEnable')}</span>
                </label>

                <div className="grid grid-cols-[1fr_90px] gap-2 pt-1">
                  <div>
                    <label className="block mb-1 opacity-85">{t('adv.tunnelHost')}</label>
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
                    <label className="block mb-1 opacity-85">{t('site.portNumber')}</label>
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
                    <label className="block mb-1 opacity-85">{t('adv.tunnelUser')}</label>
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
                    <label className="block mb-1 opacity-85">{t('adv.tunnelPwd')}</label>
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
                    <label className="block mb-1 opacity-85">{t('adv.tunnelKey')}</label>
                    <div className="flex items-center gap-1.5">
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
                      <button
                        type="button"
                        disabled={!editable || !adv.tunnel.enabled}
                        onClick={() => void handleBrowseKey('tunnel')}
                        className={browseBtnCls}
                        title={t('adv.browseFile')}
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t('adv.browseFile')}</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">{t('adv.tunnelLocalPort')}</label>
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
                  <div className="font-semibold text-[11px] opacity-90">{t('adv.ftpOptions')}</div>
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
                    <span>{t('adv.ftpPassive')}</span>
                  </label>
                </div>

                <div className={groupCls}>
                  <div className="font-semibold text-[11px] opacity-90">{t('adv.s3Options')}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block mb-1 opacity-85">{t('adv.s3Region')}</label>
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
                      <label className="block mb-1 opacity-85">{t('adv.s3UrlStyle')}</label>
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
                        <option value="virtualHost">{t('adv.s3VirtualHost')}</option>
                        <option value="path">{t('adv.s3Path')}</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block mb-1 opacity-85">{t('adv.s3Profile')}</label>
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
                <div className="font-semibold text-[11px] opacity-90">{t('adv.colorAndNote')}</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {COLOR_SWATCHES.map((sw) => {
                    const selected = draftSite.color === sw.value;
                    return (
                      <button
                        key={sw.labelKey}
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
                        {t(sw.labelKey)}
                      </button>
                    );
                  })}
                </div>
                <div>
                  <label className="block mb-1 opacity-85">{t('adv.siteNote')}</label>
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
            {editable ? t('adv.footerEditable') : t('adv.footerReadonly')}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeAdvancedDialog}
              className="px-5 py-1 bg-[#1e4b85] hover:bg-[#255da3] text-white font-medium"
            >
              {t('site.ok')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
