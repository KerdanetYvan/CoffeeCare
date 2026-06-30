export interface CPU {
  model: string;
  speed: number;
}

export interface StatPoint {
  timestamp:    number;
  cpuPercent:   number;
  freeMemoryGB: number;
}

export interface UserInfo {
  username: string;
  uid: number;
  gid: number;
  shell: string;
  homedir: string;
}

export interface SystemInfo {
  osType: string;
  platform: string;
  release: string;
  arch: string;
  hostname: string;
  cpus:            CPU[];
  cpuUsagePercent: number;
  memoryGB:        number;
  freeMemoryGB: number;
  uptimeHours:  number;
  userInfo:     UserInfo;
  statsHistory: StatPoint[];
}

export interface TempDir {
  path: string;
  label: string;
  requiresAdmin: boolean;
  sizeBytes: number;
  fileCount: number;
  lockedByProcess?: string;
}

export interface ScanResult {
  ok: boolean;
  data: TempDir[];
  runningApps: string[];
}

export interface DirCleanResult {
  path: string;
  status: 'ok' | 'partial' | 'denied';
  freedBytes: number;
  deletedCount: number;
  errorCount: number;
}

export interface CleanResult {
  ok: boolean;
  freedBytes: number;
  deletedCount: number;
  errorCount: number;
  dirs: DirCleanResult[];
}

export interface SoftwareUpdate {
  id: string;
  name: string;
  currentVersion: string;
  availableVersion: string;
  source: string;
}

export interface DriverUpdate {
  title: string;
  sizeMB: number;
}

export interface UpdatesListResult<T> {
  ok: boolean;
  data: T[];
  error?: string;
}

export interface InstallResult {
  ok: boolean;
  installed: number;
  errors: number;
}

export interface ServiceInfo {
  name:        string;
  label:       string;
  description: string;
  status:      string;   // 'Running' | 'Stopped' | 'Disabled' | 'Unknown'
  startType:   string;   // 'Automatic' | 'Manual' | 'Disabled' | 'Unknown'
  hasIssue:    boolean;
}

export interface ServiceScanResult {
  ok:     boolean;
  data:   ServiceInfo[];
  error?: string;
}

export interface RepairResult {
  ok:     boolean;
  fixed:  number;
  errors: number;
}

export interface SFCResult {
  ok:      boolean;
  status:  'healthy' | 'repaired' | 'failed' | 'unknown';
  excerpt: string;
}

export interface DriverError {
  name:        string;
  instanceId:  string;
  status:      string;
  deviceClass: string;
}

export interface DriverErrorScanResult {
  ok:     boolean;
  data:   DriverError[];
  error?: string;
}

export interface RegistryIssue {
  name:            string;
  installLocation: string;
  registryPath:    string;
}

export interface RegistryScanResult {
  ok:     boolean;
  data:   RegistryIssue[];
  error?: string;
}

export interface StartupItem {
  name:    string;
  command: string;
  enabled: boolean;
  source:  'user' | 'system';
}

export interface StartupScanResult {
  ok:     boolean;
  data:   StartupItem[];
  error?: string;
}

export interface StartupChange {
  name:    string;
  source:  'user' | 'system';
  enabled: boolean;
}

export interface DiskVolumeInfo {
  letter:       string;
  label:        string;
  sizeGB:       number;
  freeGB:       number;
  healthStatus: string;
}

export interface DiskDevice {
  name:         string;
  healthStatus: string;
  sizeGB:       number;
  volumes:      DiskVolumeInfo[];
}

export interface DiskHealthResult {
  ok:     boolean;
  disks:  DiskDevice[];
  error?: string;
}

declare global {
  interface Window {
    api: {
      // Dashboard
      getSystemInfo:      () => Promise<SystemInfo>;

      // Nettoyage
      getTempDirs:        () => Promise<ScanResult>;
      deleteDirs:         (paths: string[]) => Promise<CleanResult>;

      // Mises à jour
      getSoftwareUpdates:    () => Promise<UpdatesListResult<SoftwareUpdate>>;
      getDriverUpdates:      () => Promise<UpdatesListResult<DriverUpdate>>;
      installSoftwareStream: (packages: { id: string; name: string }[]) => Promise<{ logFile: string | null }>;
      onSwProgress:  (cb: (data: { id: string; status: 'installing' | 'ok' | 'error'; reason?: string; reboot?: 'app' | 'system' }) => void) => void;
      offSwProgress: () => void;
      openLogFile:     (path: string) => Promise<string>;
      installElevated: (pkg: { id: string; name: string }) => Promise<{ ok: boolean; reason?: string; reboot?: 'app' | 'system'; logFile?: string }>;
      closeRelatedApp: (pkg: { name: string }) => Promise<{ ok: boolean; processName?: string; reason?: 'not_found' | 'ambiguous' | 'error'; candidates?: string[] }>;
      installDrivers: () => Promise<InstallResult>;

      // Réparation
      getServices:        () => Promise<ServiceScanResult>;
      fixServices:        (names: string[]) => Promise<RepairResult>;
      runSFC:             () => Promise<SFCResult>;
      getDriverErrors:    () => Promise<DriverErrorScanResult>;
      fixDriverErrors:    (ids: string[]) => Promise<RepairResult>;
      getRegistryIssues:  () => Promise<RegistryScanResult>;
      fixRegistryIssues:  (paths: string[]) => Promise<RepairResult>;
      getStartupItems:    () => Promise<StartupScanResult>;
      setStartupItems:    (changes: StartupChange[]) => Promise<{ ok: boolean }>;
      getDiskHealth:     () => Promise<DiskHealthResult>;
      scheduleDiskCheck: (letters: string[]) => Promise<{ ok: boolean }>;

      // Paramètres
      getSettingsInfo: () => Promise<{ version: string; openAtLogin: boolean }>;
      setLoginItem:    (v: boolean) => Promise<{ ok: boolean }>;

      // Fenêtre
      minimizeWindow: () => Promise<void>;
      maximizeWindow: () => Promise<void>;
      closeWindow:    () => Promise<void>;
      isMaximized:    () => Promise<boolean>;
    };
  }
}
