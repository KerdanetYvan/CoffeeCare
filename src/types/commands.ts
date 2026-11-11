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
  /** Version installée illisible : le programme réapparaît à chaque analyse. */
  versionUnknown: boolean;
}

export interface DriverUpdate {
  title: string;
  sizeMB: number;
}

/** Analyse des logiciels : la liste proposée, et à part les programmes que l'utilisateur a masqués. */
export interface SoftwareScanResult {
  ok: boolean;
  data: SoftwareUpdate[];
  hidden: SoftwareUpdate[];
  error?: string;
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

export interface Ack {
  ok: boolean;
}

export interface SettingsInfo {
  version: string;
  openAtLogin: boolean;
}

/** Résultat de la relecture de la version après une installation réussie. */
export type Verification = 'confirmed' | 'still_outdated' | 'unverifiable';

/** Type d'échec d'une installation : dit à l'interface quel bouton proposer. */
export type FailureKind = 'needs_permission' | 'close_app' | 'retry_later' | 'update_manually' | 'other';

export interface SwProgress {
  id: string;
  status: 'installing' | 'ok' | 'error';
  reason?: string;
  kind?: FailureKind;
  reboot?: 'app' | 'system';
  verification?: Verification;
}

export interface StreamResult {
  logFile: string | null;
}

export interface ElevatedInstallResult {
  ok: boolean;
  reason?: string;
  kind?: FailureKind;
  reboot?: 'app' | 'system';
  verification?: Verification;
  logFile?: string;
}

export interface CloseAppResult {
  ok: boolean;
  processName?: string;
  reason?: 'not_found' | 'ambiguous' | 'error';
  candidates?: string[];
}
