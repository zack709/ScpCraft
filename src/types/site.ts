export type SiteProtocol = 'sftp' | 'scp' | 'ftp' | 'webdav' | 's3';
export type FtpsMode = 'none' | 'implicit' | 'explicit';
export type SiteSearchMode = 'prefix' | 'substring' | 'allFields';

export interface SshTunnelConfig {
  enabled: boolean;
  hostName: string;
  portNumber: number;
  userName: string;
  authType: string;
  privateKeyPath: string;
  localPort: number;
}

export interface SiteAdvancedConfig {
  remoteDirectory: string;
  localDirectory: string;
  privateKeyPath: string;
  useSshAgent: boolean;
  agentForwarding: boolean;
  ftpPassiveMode: boolean;
  keepaliveIntervalSecs: number;
  timeoutSecs: number;
  utf8Encoding: string;
  eolStyle: string;
  s3UrlStyle: string;
  s3Region: string;
  tunnel: SshTunnelConfig;
}

export interface SiteConfig {
  id: string;
  name: string;
  folder: string | null;
  protocol: SiteProtocol;
  ftpsMode: FtpsMode;
  hostName: string;
  portNumber: number;
  userName: string;
  anonymousLogin: boolean;
  s3EnvCredentials: boolean;
  s3Profile: string;
  hasPassword: boolean;
  hasPassphrase: boolean;
  color: string | null;
  note: string;
  advanced: SiteAdvancedConfig;
}

export interface SiteSecretBundle {
  password: string | null;
  passphrase: string | null;
  tunnelPassword: string | null;
}

export interface SiteRepositoryFile {
  version: number;
  showLoginOnStartup: boolean;
  folders: string[];
  sites: SiteConfig[];
}

export interface SiteImportResult {
  importedCount: number;
  repository: SiteRepositoryFile;
}

export interface ParsedSessionUrlResult {
  site: SiteConfig;
  password: string | null;
}

export interface GeneratedSessionUrlResult {
  url: string;
  cliCommand: string;
}

export function getDefaultPort(protocol: SiteProtocol, ftpsMode: FtpsMode): number {
  switch (protocol) {
    case 'sftp':
    case 'scp':
      return 22;
    case 'ftp':
      return ftpsMode === 'implicit' ? 990 : 21;
    case 'webdav':
    case 's3':
      return ftpsMode === 'none' ? 80 : 443;
  }
}

export function createEmptySiteConfig(): SiteConfig {
  return {
    id: '',
    name: '',
    folder: null,
    protocol: 'sftp',
    ftpsMode: 'none',
    hostName: '',
    portNumber: 22,
    userName: '',
    anonymousLogin: false,
    s3EnvCredentials: false,
    s3Profile: '',
    hasPassword: false,
    hasPassphrase: false,
    color: null,
    note: '',
    advanced: {
      remoteDirectory: '',
      localDirectory: '',
      privateKeyPath: '',
      useSshAgent: true,
      agentForwarding: false,
      ftpPassiveMode: true,
      keepaliveIntervalSecs: 0,
      timeoutSecs: 15,
      utf8Encoding: 'auto',
      eolStyle: 'lf',
      s3UrlStyle: 'virtualHost',
      s3Region: '',
      tunnel: {
        enabled: false,
        hostName: '',
        portNumber: 22,
        userName: '',
        authType: 'password',
        privateKeyPath: '',
        localPort: 0,
      },
    },
  };
}
