import { useState } from 'react';
import { ScanSearch, Download, CheckSquare, Square, Package, Cpu, AlertCircle } from 'lucide-react';
import type { SoftwareUpdate, DriverUpdate, InstallResult } from '../types/electron-api';

type PagePhase    = 'idle' | 'scanning' | 'results';
type InstallPhase = 'idle' | 'installing' | 'done';

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

  const [swInstall, setSwInstall] = useState<InstallPhase>('idle');
  const [drInstall, setDrInstall] = useState<InstallPhase>('idle');
  const [swResult,  setSwResult]  = useState<InstallResult | null>(null);
  const [drResult,  setDrResult]  = useState<InstallResult | null>(null);

  const scan = async () => {
    setPage('scanning');
    setSwError(null);
    setDrError(null);
    setSwResult(null);
    setDrResult(null);
    setSwInstall('idle');
    setDrInstall('idle');

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
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
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
    setSwInstall('installing');
    const result = await window.api.installSoftware([...selectedSw]);
    setSwResult(result);
    setSwInstall('done');
  };

  const installDrivers = async () => {
    setDrInstall('installing');
    const result = await window.api.installDrivers();
    setDrResult(result);
    setDrInstall('done');
  };

  const totalSwSelected = selectedSw.size;
  const totalDrMB = drList.reduce((acc, d) => acc + d.sizeMB, 0);

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

                <ul className="space-y-2">
                  {swList.map(pkg => {
                    const isSel = selectedSw.has(pkg.id);
                    return (
                      <li
                        key={pkg.id}
                        onClick={() => { if (swInstall === 'idle') toggleSw(pkg.id); }}
                        className={[
                          'flex items-center gap-4 p-4 border transition-colors',
                          swInstall === 'idle' ? 'cursor-pointer' : 'cursor-default',
                          isSel
                            ? 'bg-neutral-900/5 border-neutral-900/30'
                            : 'bg-white border-neutral-200 opacity-60',
                        ].join(' ')}
                      >
                        <button
                          onClick={e => { e.stopPropagation(); if (swInstall === 'idle') toggleSw(pkg.id); }}
                          disabled={swInstall !== 'idle'}
                          className="flex-shrink-0"
                        >
                          {isSel
                            ? <CheckSquare className="h-5 w-5 text-neutral-900" />
                            : <Square className="h-5 w-5 text-neutral-400" />}
                        </button>

                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{pkg.name}</p>
                          <p className="text-xs text-neutral-400 truncate">{pkg.id}</p>
                        </div>

                        <div className="text-right flex-shrink-0 text-sm">
                          <span className="text-neutral-400 line-through mr-2">{pkg.currentVersion}</span>
                          <span className="font-semibold text-green-600">→ {pkg.availableVersion}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                <div className="flex items-center justify-between pt-2">
                  {swInstall === 'idle' && (
                    <>
                      <p className="text-sm text-neutral-500">
                        {totalSwSelected > 0
                          ? `${totalSwSelected} logiciel${totalSwSelected > 1 ? 's' : ''} sélectionné${totalSwSelected > 1 ? 's' : ''}`
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
                    <div className="flex items-center gap-3 w-full">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                      <p className="text-sm text-neutral-600">
                        Installation en cours… Acceptez la demande UAC si une fenêtre s'ouvre.
                      </p>
                    </div>
                  )}

                  {swInstall === 'done' && swResult && (
                    <div className={[
                      'w-full p-3 border text-sm',
                      swResult.ok
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : 'bg-amber-50 border-amber-200 text-amber-800',
                    ].join(' ')}>
                      {swResult.ok
                        ? `✓ ${swResult.installed} logiciel${swResult.installed > 1 ? 's mis à jour' : ' mis à jour'}`
                        : `⚠ Échec partiel — ${swResult.errors} erreur${swResult.errors > 1 ? 's' : ''}`}
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
                    <div className={[
                      'w-full p-3 border text-sm',
                      drResult.ok
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : 'bg-amber-50 border-amber-200 text-amber-800',
                    ].join(' ')}>
                      {drResult.ok
                        ? '✓ Pilotes mis à jour — un redémarrage peut être nécessaire'
                        : '⚠ Échec de la mise à jour des pilotes'}
                    </div>
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
