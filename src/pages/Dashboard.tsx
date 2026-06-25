import { useEffect, useState } from "react";
import type { SystemInfo, StatPoint } from '../types/electron-api';

function SparkLine({ points, color }: { points: number[], color: string }) {
  if (points.length < 2) return null;
  const W = 100, H = 40;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - Math.min(100, Math.max(0, v)) / 100 * H;
    return `${x},${y}`;
  });
  const line = coords.join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" preserveAspectRatio="none">
      <polygon points={area} fill={color} fillOpacity="0.15" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ramPct(point: StatPoint, totalGB: number) {
  return Math.round((1 - point.freeMemoryGB / totalGB) * 100);
}

export default function Dashboard() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSystemInfo(true);
    const interval = setInterval(loadSystemInfo, 3000);
    return () => clearInterval(interval);
  }, []);

  const loadSystemInfo = async (showSpinner = false) => {
    try {
      if (showSpinner) setLoading(true);
      const info = await window.api.getSystemInfo();
      setSystemInfo(info);
    } catch (error) {
      console.error("Erreur lors du chargement des infos système:", error);
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  if (loading) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900"></div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      {systemInfo && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

          {/* Carte Système */}
          <div className="bg-white p-6 shadow-md border border-neutral-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-neutral-100">
                <span className="text-2xl">💻</span>
              </div>
              <h2 className="text-lg font-semibold">Système</h2>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600">OS :</span>
                <span className="font-medium">{systemInfo.osType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Version :</span>
                <span className="font-medium">{systemInfo.release}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Architecture :</span>
                <span className="font-medium">{systemInfo.arch}</span>
              </div>
            </div>
          </div>

          {/* Carte CPU */}
          <div className="bg-white p-6 shadow-md border border-neutral-200">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-blue-500/10">
                <span className="text-2xl">⚡</span>
              </div>
              <div>
                <h2 className="text-lg font-semibold">Processeur</h2>
                <p className="text-xs text-neutral-400 truncate max-w-[160px]">
                  {systemInfo.cpus[0]?.model.split(' ').slice(0, 4).join(' ') || 'N/A'} · {systemInfo.cpus.length} cœurs
                </p>
              </div>
            </div>
            {(() => {
              const pct    = systemInfo.cpuUsagePercent;
              const color  = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#3b82f6';
              const cpuPts = systemInfo.statsHistory.map(p => p.cpuPercent);
              return (
                <>
                  <SparkLine points={cpuPts} color={color} />
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-neutral-400">1 min</span>
                    <span className="text-sm font-semibold" style={{ color }}>{pct}%</span>
                    <span className="text-xs text-neutral-400">maintenant</span>
                  </div>
                </>
              );
            })()}
          </div>

          {/* Carte Mémoire */}
          <div className="bg-white p-6 shadow-md border border-neutral-200">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-green-500/10">
                <span className="text-2xl">🧠</span>
              </div>
              <div>
                <h2 className="text-lg font-semibold">Mémoire</h2>
                <p className="text-xs text-neutral-400">
                  {parseFloat((systemInfo.memoryGB - systemInfo.freeMemoryGB).toFixed(1))} Go utilisés sur {systemInfo.memoryGB} Go
                </p>
              </div>
            </div>
            {(() => {
              const pct   = Math.round((1 - systemInfo.freeMemoryGB / systemInfo.memoryGB) * 100);
              const color = pct >= 85 ? '#ef4444' : pct >= 65 ? '#f59e0b' : '#22c55e';
              const ramPts = systemInfo.statsHistory.map(p => ramPct(p, systemInfo.memoryGB));
              return (
                <>
                  <SparkLine points={ramPts} color={color} />
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-neutral-400">1 min</span>
                    <span className="text-sm font-semibold" style={{ color }}>{pct}%</span>
                    <span className="text-xs text-neutral-400">maintenant</span>
                  </div>
                </>
              );
            })()}
          </div>

          {/* Carte Machine */}
          <div className="bg-white p-6 shadow-md border border-neutral-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-purple-500/10">
                <span className="text-2xl">🖥️</span>
              </div>
              <h2 className="text-lg font-semibold">Machine</h2>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600">Nom :</span>
                <span className="font-medium">{systemInfo.hostname}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Utilisateur :</span>
                <span className="font-medium">{systemInfo.userInfo?.username || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Allumé depuis :</span>
                <span className="font-medium">{systemInfo.uptimeHours}h</span>
              </div>
            </div>
          </div>

        </div>
      )}

      {!systemInfo && !loading && (
        <div className="bg-red-50 border border-red-200 p-4">
          <p className="text-red-800">
            Impossible de charger les informations système.
          </p>
        </div>
      )}
    </section>
  );
}
