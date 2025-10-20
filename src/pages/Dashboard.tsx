import { useEffect, useState } from "react";

interface CPU {
  model: string;
  speed: number;
}

interface UserInfo {
  username: string;
  uid: number;
  gid: number;
  shell: string;
  homedir: string;
}

interface SystemInfo {
  osType: string;
  platform: string;
  release: string;
  arch: string;
  hostname: string;
  cpus: CPU[];
  memoryGB: number;
  uptimeHours: number;
  userInfo: UserInfo;
}

interface TempDirs {
  ok: boolean;
  data: string[];
}

declare global {
  interface Window {
    api: {
      getSystemInfo: () => Promise<SystemInfo>;
      getTempDirs: () => Promise<TempDirs>;
    };
  }
}

export default function Dashboard() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [tempDirs, setTempDirs] = useState<TempDirs | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSystemInfo();
  }, []);

  const loadSystemInfo = async () => {
    try {
      setLoading(true);
      const info = await window.api.getSystemInfo();
      const tempDirsInfo = await window.api.getTempDirs();
      setTempDirs(tempDirsInfo);
      setSystemInfo(info);
      console.log("Dossiers temporaires détectés:", tempDirsInfo);
    } catch (error) {
      console.error("Erreur lors du chargement des infos système:", error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-bole"></div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <button
          onClick={loadSystemInfo}
          className="px-4 py-2 bg-bole text-white rounded-lg hover:bg-bole/90 transition-colors"
        >
          🔄 Rafraîchir
        </button>
      </div>

      {systemInfo && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Carte Système */}
          <div className="bg-white dark:bg-neutral-800 p-6 rounded-lg shadow-md border border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-bole/10 rounded-lg">
                <span className="text-2xl">💻</span>
              </div>
              <h2 className="text-lg font-semibold">Système</h2>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">OS:</span>
                <span className="font-medium">{systemInfo.osType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Plateforme:</span>
                <span className="font-medium">{systemInfo.platform}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Version:</span>
                <span className="font-medium">{systemInfo.release}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Architecture:</span>
                <span className="font-medium">{systemInfo.arch}</span>
              </div>
            </div>
          </div>

          {/* Carte CPU */}
          <div className="bg-white dark:bg-neutral-800 p-6 rounded-lg shadow-md border border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <span className="text-2xl">⚡</span>
              </div>
              <h2 className="text-lg font-semibold">Processeur</h2>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Modèle:</span>
                <span className="font-medium text-right truncate ml-2">
                  {systemInfo.cpus[0]?.model.split(' ').slice(0, 3).join(' ') || 'N/A'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Cœurs:</span>
                <span className="font-medium">{systemInfo.cpus.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Vitesse:</span>
                <span className="font-medium">
                  {systemInfo.cpus[0]?.speed ? `${systemInfo.cpus[0].speed} MHz` : 'N/A'}
                </span>
              </div>
            </div>
          </div>

          {/* Carte Mémoire */}
          <div className="bg-white dark:bg-neutral-800 p-6 rounded-lg shadow-md border border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-green-500/10 rounded-lg">
                <span className="text-2xl">🧠</span>
              </div>
              <h2 className="text-lg font-semibold">Mémoire</h2>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">RAM Totale:</span>
                <span className="font-medium">{systemInfo.memoryGB} GB</span>
              </div>
              <div className="mt-4">
                <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full"
                    style={{ width: "65%" }}
                  ></div>
                </div>
                <p className="text-xs text-neutral-500 mt-1">Utilisation estimée: 65%</p>
              </div>
            </div>
          </div>

          {/* Carte Machine */}
          <div className="bg-white dark:bg-neutral-800 p-6 rounded-lg shadow-md border border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-purple-500/10 rounded-lg">
                <span className="text-2xl">🖥️</span>
              </div>
              <h2 className="text-lg font-semibold">Machine</h2>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Nom:</span>
                <span className="font-medium">{systemInfo.hostname}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Utilisateur:</span>
                <span className="font-medium">{systemInfo.userInfo?.username || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Uptime:</span>
                <span className="font-medium">{systemInfo.uptimeHours}h</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Message si pas d'infos */}
      {!systemInfo && !loading && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-200">
            ❌ Impossible de charger les informations système
          </p>
        </div>
      )}
    </section>
  );
}
