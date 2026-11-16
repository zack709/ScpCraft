import { useEffect, useMemo, useState } from 'react';
import { Check, ClipboardCopy, Code2, FileCode, Link2, X } from 'lucide-react';
import { translate } from '../../i18n';
import {
  urlGeneratorApi,
  type GenerateUrlBundle,
} from '../../services/phase6Api';
import { useSiteStore } from '../../stores/useSiteStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { createEmptySiteConfig, type SiteConfig } from '../../types/site';

type GenTab = 'url' | 'script' | 'code';
type ScriptFormat = 'winscpScript' | 'batchScript' | 'cliCommand' | 'powershellScript';
type CodeFormat = 'csharpCode' | 'powershellSdkCode' | 'rustCode';

export function GenerateUrlModal() {
  const { theme, locale, activeModal, tabs, activeTabId, closeModal } =
    useWorkspaceStore();
  const { sites, draftSite } = useSiteStore();

  const isOpen = activeModal === 'generate_url';
  const isDark = theme === 'dark';

  const [tab, setTab] = useState<GenTab>('url');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [includeUsername, setIncludeUsername] = useState(true);
  const [includePassword, setIncludePassword] = useState(false);
  const [includeHostKey, setIncludeHostKey] = useState(true);
  const [includeRemoteDir, setIncludeRemoteDir] = useState(true);
  const [winscpSpecific, setWinscpSpecific] = useState(true);
  const [saveExtension, setSaveExtension] = useState(false);
  const [rawSettings, setRawSettings] = useState(false);
  const [scriptFormat, setScriptFormat] = useState<ScriptFormat>('winscpScript');
  const [codeFormat, setCodeFormat] = useState<CodeFormat>('csharpCode');
  const [bundle, setBundle] = useState<GenerateUrlBundle | null>(null);
  const [copied, setCopied] = useState(false);

  const activeSessionSite = tabs.find((x) => x.id === activeTabId)?.site ?? null;

  const candidateSites = useMemo(() => {
    const map = new Map<string, SiteConfig>();
    if (activeSessionSite) {
      map.set(activeSessionSite.id || '__active__', activeSessionSite);
    }
    for (const s of sites) {
      map.set(s.id, s);
    }
    if (draftSite.hostName.trim()) {
      map.set('__draft__', { ...draftSite, id: draftSite.id || '__draft__', name: draftSite.name || `${draftSite.userName || 'user'}@${draftSite.hostName}` });
    }
    return Array.from(map.entries()).map(([key, site]) => ({ key, site }));
  }, [activeSessionSite, sites, draftSite]);

  useEffect(() => {
    if (!isOpen) return;
    setCopied(false);
    if (activeSessionSite) {
      setSelectedSiteId(activeSessionSite.id || '__active__');
    } else if (sites[0]) {
      setSelectedSiteId(sites[0].id);
    } else if (draftSite.hostName.trim()) {
      setSelectedSiteId('__draft__');
    } else {
      setSelectedSiteId('__sample__');
    }
  }, [isOpen]);

  const activeSite: SiteConfig = useMemo(() => {
    const hit = candidateSites.find((c) => c.key === selectedSiteId)?.site;
    if (hit) return hit;
    if (candidateSites[0]) return candidateSites[0].site;
    const sample = createEmptySiteConfig();
    sample.name = 'example-sftp';
    sample.hostName = 'example.com';
    sample.userName = 'deploy';
    sample.advanced.remoteDirectory = '/var/www';
    return sample;
  }, [candidateSites, selectedSiteId]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void urlGeneratorApi
      .generateBundle({
        site: activeSite,
        includeUsername,
        includePassword,
        includeHostKey,
        includeRemoteDir,
        winscpSpecific,
        saveExtension,
        rawSettings,
        hostKeyFingerprint: null,
      })
      .then((res) => {
        if (!cancelled) setBundle(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    activeSite,
    includeUsername,
    includePassword,
    includeHostKey,
    includeRemoteDir,
    winscpSpecific,
    saveExtension,
    rawSettings,
  ]);

  if (!isOpen) return null;

  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const displayedText = !bundle
    ? ''
    : tab === 'url'
      ? bundle.url
      : tab === 'script'
        ? bundle[scriptFormat]
        : bundle[codeFormat];

  const handleCopy = async () => {
    if (!displayedText) return;
    try {
      await navigator.clipboard.writeText(displayedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const selectCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none ${
    isDark
      ? 'bg-[#1e1e1e] border-[#3c3c3f] text-[#e0e0e0]'
      : 'bg-white border-slate-300 text-slate-900'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
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
            <Link2 className="w-4 h-4 text-sky-400" />
            <span>{t('gen.title')}</span>
          </div>
          <button type="button" onClick={closeModal} className="p-0.5 rounded opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {candidateSites.length > 0 && (
            <div>
              <label className="block mb-1 text-[11px] opacity-80">{t('gen.site')}</label>
              <select
                value={selectedSiteId}
                onChange={(e) => setSelectedSiteId(e.target.value)}
                className={selectCls}
              >
                {candidateSites.map(({ key, site }) => (
                  <option key={key} value={key}>
                    {site.name || site.hostName} ({site.protocol.toUpperCase()} — {site.hostName})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1 border-b border-current/10">
            <button
              type="button"
              onClick={() => setTab('url')}
              className={`px-3 py-1.5 border-b-2 text-[11px] font-medium inline-flex items-center gap-1.5 ${
                tab === 'url'
                  ? 'border-sky-500 text-sky-400'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              {t('gen.tabUrl')}
            </button>
            <button
              type="button"
              onClick={() => setTab('script')}
              className={`px-3 py-1.5 border-b-2 text-[11px] font-medium inline-flex items-center gap-1.5 ${
                tab === 'script'
                  ? 'border-sky-500 text-sky-400'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              {t('gen.tabScript')}
            </button>
            <button
              type="button"
              onClick={() => setTab('code')}
              className={`px-3 py-1.5 border-b-2 text-[11px] font-medium inline-flex items-center gap-1.5 ${
                tab === 'code'
                  ? 'border-sky-500 text-sky-400'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              {t('gen.tabCode')}
            </button>
          </div>

          {tab === 'url' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeUsername}
                  onChange={(e) => setIncludeUsername(e.target.checked)}
                />
                <span>{t('gen.includeUser')}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePassword}
                  onChange={(e) => setIncludePassword(e.target.checked)}
                />
                <span>{t('gen.includePass')}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeRemoteDir}
                  onChange={(e) => setIncludeRemoteDir(e.target.checked)}
                />
                <span>{t('gen.includeDir')}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeHostKey}
                  onChange={(e) => setIncludeHostKey(e.target.checked)}
                />
                <span>{t('gen.includeHostKey')}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={winscpSpecific}
                  onChange={(e) => setWinscpSpecific(e.target.checked)}
                />
                <span>{t('gen.winscpSpec')}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveExtension}
                  onChange={(e) => setSaveExtension(e.target.checked)}
                />
                <span>{t('gen.saveExt')}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer sm:col-span-2">
                <input
                  type="checkbox"
                  checked={rawSettings}
                  onChange={(e) => setRawSettings(e.target.checked)}
                />
                <span>{t('gen.rawSettings')}</span>
              </label>
            </div>
          )}

          {tab === 'script' && (
            <div>
              <select
                value={scriptFormat}
                onChange={(e) => setScriptFormat(e.target.value as ScriptFormat)}
                className={selectCls}
              >
                <option value="winscpScript">Script file (.txt)</option>
                <option value="batchScript">Windows Batch file (.bat)</option>
                <option value="cliCommand">Command-line (winscp.com /command)</option>
                <option value="powershellScript">PowerShell CLI script</option>
              </select>
            </div>
          )}

          {tab === 'code' && (
            <div>
              <select
                value={codeFormat}
                onChange={(e) => setCodeFormat(e.target.value as CodeFormat)}
                className={selectCls}
              >
                <option value="csharpCode">C# (.NET SessionOptions)</option>
                <option value="powershellSdkCode">PowerShell (.NET Assembly)</option>
                <option value="rustCode">Rust / ScpCraft Session Profile</option>
              </select>
            </div>
          )}

          <textarea
            readOnly
            value={displayedText}
            rows={9}
            className={`w-full rounded border p-2.5 font-mono text-[11px] outline-none resize-none ${
              isDark
                ? 'bg-[#141416] border-[#333337] text-[#e0e0e0]'
                : 'bg-slate-50 border-slate-300 text-slate-900'
            }`}
          />

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              disabled={!displayedText}
              onClick={() => void handleCopy()}
              className="px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
              {copied ? t('gen.copied') : t('gen.copy')}
            </button>

            <button
              type="button"
              onClick={closeModal}
              className={`px-3.5 py-1.5 rounded border text-xs ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233]'
                  : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              {t('gen.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
