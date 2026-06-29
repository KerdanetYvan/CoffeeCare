import { useState } from 'react';
import { ScanSearch, Download, CheckSquare, Square, Package, Cpu, AlertCircle, CheckCircle2, XCircle, RefreshCw, Power } from 'lucide-react';
import type { SoftwareUpdate, DriverUpdate, InstallResult } from '../types/electron-api';

type PagePhase    = 'idle' | 'scanning' | 'results';
type InstallPhase = 'idle' | 'installing' | 'done';
type SwStatus = 'installing' | 'ok' | 'error';
interface SwItem { status: SwStatus; reason?: string; reboot?: 'app' | 'system' }

function formatMB(mb: number): string {
  if (mb < 1)    return '< 1 Mo';
  if (mb < 1024) return `${mb.toFixed(0)} Mo`;
  return `${(mb / 1024).toFixed(1)} Go`;
}

export default function Updates() {
  const [page,   setPage]   = useState<PagePhase>('idle');
  const [swList, setSwList] = useState<SoftwareUpdate[]>([]);
  const [drList, setDrList] = useState<DriverUpdate[]>([]);
  const [swError, setSwError] = useState<string | null>(null);
  const [drError, setDrError] = useState<string | null>(null);

  const [selectedSw, setSelectedSw] = useState<Set<string>>(new Set());

  const [swInstall, setSwInstall]       = useState<InstallPhase>('idle');
  const [swItemStatus, setSwItemStatus] = useState<Map<string, SwItem>>(new Map());
  const [logFile, setLogFile]           = useState<string | null>(null);

  const [drInstall, setDrInstall] = useState<InstallPhase>('idle');
  const [drResult,  setDrResult]  = useState<InstallResult | null>(null);

  const scan = async () => {
    window.api.offSwProgress();
    setPage('scanning');
    setSwError(null);
    setDrError(null);
    setSwInstall('idle');
    setSwItemStatus(new Map());
    setLogFile(null);
    setDrInstall('idle');
    setDrResult(null);

    const [sw, dr] = await Promise.all([
      window.api.getSoftwareUpdates(),
      window.api.getDriverUpdates(),
    ]);

    setSwList(sw.data);
    setDrList(dr.data);
    setSwError(sw.ok ? null : (sw.error ?? 'Erreur inconnue'));
    setDrError(dr.ok ? null : (dr.error ?? 'Erreur inconnue'));
    setSelectedSw(new Set(sw.data.map(s => s.id)));
    setPage('results');
  };

  const toggleSw = (id: string) => {
    setSelectedSw(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllSw = () => {
    setSelectedSw(
      selectedSw.size === swList.length
        ? new Set()
        : new Set(swList.map(s => s.id))
    );
  };

  const installSoftware = async () => {
    if (selectedSw.size === 0) return;

    const packages = swList
      .filter(p => selectedSw.has(p.id))
      .map(p => ({ id: p.id, name: p.name }));

    setSwInstall('installing');
    setSwItemStatus(new Map());
    setLogFile(null);

    window.api.onSwProgress(({ id, status, reason, reboot }) => {
      setSwItemStatus(prev => new Map(prev).set(id, { status, reason, reboot }));
    });

    const result = await window.api.installSoftwareStream(packages);

    window.api.offSwProgress();
    setLogFile(result?.logFile ?? null);
    setSwInstall('done');
  };

  const installDrivers = async () => {
    setDrInstall('installing');
    const result = await window.api.installDrivers();
    setDrResult(result);
    setDrInstall('done');
  };

  const totalDrMB = drList.reduce((acc, d) => acc + d.sizeMB, 0);

  // Packages affichés : tous en idle, seulement les sélectionnés pendant/après install
  const visibleSw = swInstall === 'idle'
    ? swList
    : swList.filter(p => selectedSw.has(p.id));

  // Compteurs pour le résumé en phase done
  const okCount  = [...swItemStatus.values()].filter(s => s.status === 'ok').length;
  const errCount = [...swItemStatus.values()].filter(s => s.status === 'error').length;

  return (
    <section className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Mises à jour</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Logiciels via winget · Pilotes via Windows Update
          </p>
        </div>

        {(page === 'idle' || page === 'results') && (
          <button
            onClick={scan}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
          >
            <ScanSearch className="h-4 w-4" />
            {page === 'results' ? 'Rescanner' : 'Scanner'}
          </button>
        )}
      </div>

      {/* Scanning */}
      {page === 'scanning' && (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900" />
          <p className="text-neutral-500">Recherche des mises à jour…</p>
          <p className="text-xs text-neutral-400">La recherche de pilotes peut prendre quelques secondes</p>
        </div>
      )}

      {/* Results */}
      {page === 'results' && (
        <div className="space-y-8">

          {/* ── Logiciels ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-neutral-600" />
              <h2 className="text-lg font-semibold">Logiciels</h2>
              {swList.length > 0 && (
                <span className="text-xs bg-neutral-900 text-white px-2 py-0.5">
                  {swList.length}
                </span>
              )}
            </div>

            {swError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>winget indisponible — {swError}</span>
              </div>
            )}

            {!swError && swList.length === 0 && (
              <p className="text-sm text-neutral-400 py-2">Tous vos logiciels sont à jour.</p>
            )}

            {swList.length > 0 && (
              <>
                {/* Sélection tout — seulement en idle */}
                {swInstall === 'idle' && (
                  <div className="flex items-center gap-3 pb-2 border-b border-neutral-200">
                    <button
                      onClick={toggleAllSw}
                      className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
                    >
                      {selectedSw.size === swList.length
                        ? <CheckSquare className="h-4 w-4 text-neutral-900" />
                        : <Square className="h-4 w-4" />}
                      Tout sélectionner
                    </button>
                  </div>
                )}

                <ul className="space-y-2">
                  {visibleSw.map(pkg => {
                    const isSel     = selectedSw.has(pkg.id);
                    const item      = swItemStatus.get(pkg.id);
                    const status    = item?.status;
                    const isPending = swInstall !== 'idle' && !item;

                    return (
                      <li
                        key={pkg.id}
                        onClick={() => { if (swInstall === 'idle') toggleSw(pkg.id); }}
                        className={[
                          'flex items-center gap-4 p-4 border transition-colors',
                          swInstall === 'idle' ? 'cursor-pointer' : 'cursor-default',
                          swInstall === 'idle'
                            ? (isSel ? 'bg-neutral-900/5 border-neutral-900/30' : 'bg-white border-neutral-200 opacity-60')
                            : 'bg-white border-neutral-200',
                        ].join(' ')}
                      >
                        {/* Icône gauche */}
                        {swInstall === 'idle' ? (
                          <button
                            onClick={e => { e.stopPropagation(); toggleSw(pkg.id); }}
                            className="flex-shrink-0"
                          >
                            {isSel
                              ? <CheckSquare className="h-5 w-5 text-neutral-900" />
                              : <Square className="h-5 w-5 text-neutral-400" />}
                          </button>
                        ) : (
                          <span className="flex-shrink-0 flex items-center justify-center h-5 w-5">
                            {isPending && (
                              <span className="h-2 w-2 rounded-full bg-neutral-300" />
                            )}
                            {status === 'installing' && (
                              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900" />
                            )}
                            {status === 'ok'    && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                            {status === 'error' && <XCircle      className="h-5 w-5 text-red-500"   />}
                          </span>
                        )}

                        {/* Contenu */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm">{pkg.name}</p>
                            {status === 'ok' && item?.reboot === 'app' && (
                              <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5">
                                <RefreshCw className="h-3 w-3" />
                                Redémarrez le logiciel
                              </span>
                            )}
                            {status === 'ok' && item?.reboot === 'system' && (
                              <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5">
                                <Power className="h-3 w-3" />
                                Redémarrez votre PC
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5">
                            <p className="text-xs text-neutral-400 truncate">
                              {swInstall === 'idle'    && pkg.id}
                              {isPending               && 'En attente…'}
                              {status === 'installing' && 'Installation…'}
                              {status === 'ok'         && 'Mis à jour'}
                              {status === 'error'      && (item?.reason ?? 'Échec de la mise à jour')}
                            </p>
                            {status === 'error' && item?.reason === 'Droits administrateur probablement requis' && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  setSwItemStatus(prev => new Map(prev).set(pkg.id, { status: 'installing' }));
                                  const result = await window.api.installElevated({ id: pkg.id, name: pkg.name });
                                  setSwItemStatus(prev => new Map(prev).set(pkg.id, {
                                    status: result.ok ? 'ok' : 'error',
                                    reason: result.reason,
                                    reboot: result.reboot,
                                  }));
                                }}
                                className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-900 transition-colors mt-0.5"
                              >
                                Réessayer en administrateur
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Versions */}
                        <div className="text-right flex-shrink-0 text-sm">
                          <span className="text-neutral-400 line-through mr-2">{pkg.currentVersion}</span>
                          <span className="font-semibold">{pkg.availableVersion}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {/* Barre d'action */}
                <div className="flex items-center justify-between pt-2">
                  {swInstall === 'idle' && (
                    <>
                      <p className="text-sm text-neutral-500">
                        {selectedSw.size > 0
                          ? `${selectedSw.size} logiciel${selectedSw.size > 1 ? 's' : ''} sélectionné${selectedSw.size > 1 ? 's' : ''}`
                          : 'Aucune sélection'}
                      </p>
                      <button
                        onClick={installSoftware}
                        disabled={selectedSw.size === 0}
                        className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Download className="h-4 w-4" />
                        Mettre à jour la sélection
                      </button>
                    </>
                  )}

                  {swInstall === 'installing' && (
                    <p className="text-sm text-neutral-500">
                      {[...swItemStatus.values()].filter(s => s.status === 'ok' || s.status === 'error').length} / {selectedSw.size} traité{selectedSw.size > 1 ? 's' : ''}
                    </p>
                  )}

                  {swInstall === 'done' && (
                    <div className="flex items-center gap-4">
                      <p className="text-sm text-neutral-600">
                        {okCount > 0 && (
                          <><span className="font-medium">{okCount}</span> mis à jour</>
                        )}
                        {okCount > 0 && errCount > 0 && ' · '}
                        {errCount > 0 && (
                          <><span className="font-medium">{errCount}</span> échec{errCount > 1 ? 's' : ''}</>
                        )}
                      </p>
                      {logFile && (
                        <button
                          onClick={() => window.api.openLogFile(logFile)}
                          className="text-sm text-neutral-500 underline underline-offset-2 hover:text-neutral-900 transition-colors"
                        >
                          Voir le rapport d'erreur
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Pilotes ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-neutral-600" />
              <h2 className="text-lg font-semibold">Pilotes</h2>
              {drList.length > 0 && (
                <span className="text-xs bg-neutral-900 text-white px-2 py-0.5">
                  {drList.length}
                </span>
              )}
            </div>

            {drError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>Erreur Windows Update — {drError}</span>
              </div>
            )}

            {!drError && drList.length === 0 && (
              <p className="text-sm text-neutral-400 py-2">Tous vos pilotes sont à jour.</p>
            )}

            {drList.length > 0 && (
              <>
                <ul className="space-y-2">
                  {drList.map((dr, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-4 p-4 border bg-white border-neutral-200"
                    >
                      <Cpu className="h-5 w-5 text-neutral-400 flex-shrink-0" />
                      <p className="flex-1 font-medium text-sm">{dr.title}</p>
                      <span className="text-sm text-neutral-500 flex-shrink-0">{formatMB(dr.sizeMB)}</span>
                    </li>
                  ))}
                </ul>

                <div className="flex items-center justify-between pt-2">
                  {drInstall === 'idle' && (
                    <>
                      <p className="text-sm text-neutral-500">
                        {drList.length} pilote{drList.length > 1 ? 's' : ''} · {formatMB(totalDrMB)} au total
                      </p>
                      <button
                        onClick={installDrivers}
                        className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                      >
                        <Download className="h-4 w-4" />
                        Installer tous les pilotes
                      </button>
                    </>
                  )}

                  {drInstall === 'installing' && (
                    <div className="flex items-center gap-3 w-full">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                      <p className="text-sm text-neutral-600">
                        Téléchargement et installation… Acceptez la demande UAC si une fenêtre s'ouvre.
                      </p>
                    </div>
                  )}

                  {drInstall === 'done' && drResult && (
                    <p className="text-sm text-neutral-600">
                      {drResult.ok
                        ? 'Pilotes mis à jour — un redémarrage peut être nécessaire'
                        : 'Échec de la mise à jour des pilotes'}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

        </div>
      )}
    </section>
  );
}
