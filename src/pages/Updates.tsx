import { Fragment, useState } from 'react';
import { ScanSearch, Download, CheckSquare, Square, Package, Cpu, AlertCircle, CheckCircle2, XCircle, RefreshCw, Power, TriangleAlert, ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { SoftwareUpdate, DriverUpdate, InstallResult, SoftwareScanResult, UpdatesListResult, SwProgress, Verification, FailureKind, StreamResult, ElevatedInstallResult, CloseAppResult } from '../types/commands';

type PagePhase    = 'idle' | 'scanning' | 'results';
type InstallPhase = 'idle' | 'installing' | 'done';
type SwStatus = 'installing' | 'ok' | 'error';
interface SwItem { status: SwStatus; reason?: string; kind?: FailureKind; reboot?: 'app' | 'system'; verification?: Verification; closeMsg?: string }

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

  // Programmes que l'utilisateur a choisi de ne plus se voir proposer
  const [hiddenList, setHiddenList] = useState<SoftwareUpdate[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [hideError, setHideError]   = useState<string | null>(null);

  const [swInstall, setSwInstall]       = useState<InstallPhase>('idle');
  const [swItemStatus, setSwItemStatus] = useState<Map<string, SwItem>>(new Map());
  const [logFile, setLogFile]           = useState<string | null>(null);

  const [drInstall, setDrInstall] = useState<InstallPhase>('idle');
  const [drResult,  setDrResult]  = useState<InstallResult | null>(null);

  const scan = async () => {
    setPage('scanning');
    setSwError(null);
    setDrError(null);
    setSwInstall('idle');
    setSwItemStatus(new Map());
    setLogFile(null);
    setDrInstall('idle');
    setDrResult(null);

    const [sw, dr] = await Promise.all([
      invoke<SoftwareScanResult>('updates_get_software'),
      invoke<UpdatesListResult<DriverUpdate>>('updates_get_drivers'),
    ]);

    setSwList(sw.data);
    setHiddenList(sw.hidden ?? []);
    setShowHidden(false);
    setHideError(null);
    setDrList(dr.data);
    setSwError(sw.ok ? null : (sw.error ?? 'Erreur inconnue'));
    setDrError(dr.ok ? null : (dr.error ?? 'Erreur inconnue'));
    // Les versions illisibles ne sont pas présélectionnées : elles réapparaîtraient à chaque analyse.
    setSelectedSw(new Set(sw.data.filter(s => !s.versionUnknown).map(s => s.id)));
    setPage('results');
  };

  const toggleSw = (id: string) => {
    setSelectedSw(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const byName = (a: SoftwareUpdate, b: SoftwareUpdate) => a.name.localeCompare(b.name);

  const hideSw = async (pkg: SoftwareUpdate) => {
    try {
      await invoke<string[]>('updates_hide', { id: pkg.id });
    } catch {
      setHideError('Impossible de masquer ce programme, réessayez');
      return;
    }
    setHideError(null);
    setSwList(prev => prev.filter(p => p.id !== pkg.id));
    setSelectedSw(prev => { const next = new Set(prev); next.delete(pkg.id); return next; });
    setHiddenList(prev => [...prev, pkg].sort(byName));
  };

  const unhideSw = async (pkg: SoftwareUpdate) => {
    try {
      await invoke<string[]>('updates_unhide', { id: pkg.id });
    } catch {
      setHideError('Impossible de proposer ce programme à nouveau, réessayez');
      return;
    }
    setHideError(null);
    setHiddenList(prev => prev.filter(p => p.id !== pkg.id));
    setSwList(prev => [...prev, pkg].sort(byName));
    // Comme après une analyse : les versions illisibles ne sont pas présélectionnées.
    if (!pkg.versionUnknown) setSelectedSw(prev => new Set(prev).add(pkg.id));
  };

  const unhideAllSw = async () => {
    try {
      await invoke<string[]>('updates_unhide_all');
    } catch {
      setHideError('Impossible de proposer ces programmes à nouveau, réessayez');
      return;
    }
    setHideError(null);
    const back = hiddenList;
    setHiddenList([]);
    setSwList(prev => [...prev, ...back].sort(byName));
    setSelectedSw(prev => {
      const next = new Set(prev);
      back.filter(p => !p.versionUnknown).forEach(p => next.add(p.id));
      return next;
    });
  };

  const toggleAllSw = () => {
    setSelectedSw(
      allKnownSelected
        ? new Set()
        : new Set(knownSw.map(s => s.id))
    );
  };

  const installSoftware = async () => {
    if (selectedSw.size === 0) return;

    const packages = swList
      .filter(p => selectedSw.has(p.id))
      .map(p => ({ id: p.id, name: p.name, currentVersion: p.currentVersion }));

    setSwInstall('installing');
    setSwItemStatus(new Map());
    setLogFile(null);

    const onProgress = new Channel<SwProgress>();
    onProgress.onmessage = ({ id, status, reason, kind, reboot, verification }) => {
      setSwItemStatus(prev => new Map(prev).set(id, { status, reason, kind, reboot, verification }));
    };

    const result = await invoke<StreamResult>('updates_install_software_stream', { packages, onProgress });

    setLogFile(result?.logFile ?? null);
    setSwInstall('done');
  };

  const closeApp = async (pkg: SoftwareUpdate) => {
    setSwItemStatus(prev => {
      const next = new Map(prev);
      const cur = next.get(pkg.id);
      if (cur) next.set(pkg.id, { ...cur, closeMsg: 'Fermeture en cours…' });
      return next;
    });

    const result = await invoke<CloseAppResult>('updates_close_related_app', { pkg: { name: pkg.name } });
    const closeMsg = result.ok
      ? `${result.processName} fermé — relancez la mise à jour pour réessayer`
      : result.reason === 'ambiguous'
        ? "Plusieurs applications correspondent — fermez-la manuellement puis relancez la mise à jour"
        : result.reason === 'not_found'
          ? "Application non trouvée automatiquement — fermez-la manuellement puis relancez la mise à jour"
          : 'Erreur lors de la fermeture — fermez-la manuellement';

    setSwItemStatus(prev => {
      const next = new Map(prev);
      const cur = next.get(pkg.id);
      if (cur) next.set(pkg.id, { ...cur, closeMsg });
      return next;
    });
  };

  const installDrivers = async () => {
    setDrInstall('installing');
    const result = await invoke<InstallResult>('updates_install_drivers');
    setDrResult(result);
    setDrInstall('done');
  };

  const totalDrMB = drList.reduce((acc, d) => acc + d.sizeMB, 0);

  // Packages affichés : tous en idle, seulement les sélectionnés pendant/après install
  // Versions lisibles d'abord ; les versions illisibles sont présentées à part.
  const knownSw   = swList.filter(p => !p.versionUnknown);
  const unknownSw = swList.filter(p => p.versionUnknown);
  const orderedSw = [...knownSw, ...unknownSw];
  const allKnownSelected = knownSw.length > 0 && knownSw.every(p => selectedSw.has(p.id));

  const visibleSw = swInstall === 'idle'
    ? orderedSw
    : orderedSw.filter(p => selectedSw.has(p.id));

  // Compteurs pour le résumé en phase done
  const staleCount = [...swItemStatus.values()].filter(s => s.status === 'ok' && s.verification === 'still_outdated').length;
  const okCount  = [...swItemStatus.values()].filter(s => s.status === 'ok').length - staleCount;
  const errCount = [...swItemStatus.values()].filter(s => s.status === 'error').length;

  return (
    <section className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Mises à jour</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Logiciels et pilotes de votre PC
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
                <span>Analyse impossible — {swError}</span>
              </div>
            )}

            {!swError && swList.length === 0 && (
              <p className="text-sm text-neutral-400 py-2">
                {hiddenList.length > 0 ? 'Aucune mise à jour proposée.' : 'Tous vos logiciels sont à jour.'}
              </p>
            )}

            {swList.length > 0 && (
              <>
                {/* Sélection tout — seulement en idle */}
                {swInstall === 'idle' && knownSw.length > 0 && (
                  <div className="flex items-center gap-3 pb-2 border-b border-neutral-200">
                    <button
                      onClick={toggleAllSw}
                      className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
                    >
                      {allKnownSelected
                        ? <CheckSquare className="h-4 w-4 text-neutral-900" />
                        : <Square className="h-4 w-4" />}
                      Tout sélectionner
                    </button>
                  </div>
                )}

                <ul className="space-y-2">
                  {visibleSw.map((pkg, index) => {
                    const startsUnknownGroup = swInstall === 'idle' && pkg.versionUnknown && index === knownSw.length;
                    const isSel     = selectedSw.has(pkg.id);
                    const item      = swItemStatus.get(pkg.id);
                    const status    = item?.status;
                    const isPending = swInstall !== 'idle' && !item;

                    return (
                      <Fragment key={pkg.id}>
                      {startsUnknownGroup && (
                        <li className="pt-4 pb-1 list-none">
                          <p className="text-sm font-medium text-neutral-700">Version actuelle non détectable</p>
                          <p className="text-xs text-neutral-500 mt-0.5">
                            Windows ne sait pas quelle version de ces programmes est installée. Ils peuvent réapparaître
                            dans la liste même après une mise à jour. Ils ne sont pas sélectionnés par défaut.
                          </p>
                        </li>
                      )}
                      <li
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
                            {status === 'ok' && item?.verification !== 'still_outdated' && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                            {status === 'ok' && item?.verification === 'still_outdated' && <TriangleAlert className="h-5 w-5 text-amber-500" />}
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
                              {status === 'ok' && item?.verification === 'confirmed'      && 'Mis à jour — version confirmée'}
                              {status === 'ok' && item?.verification === 'still_outdated' && "Installé, mais l'ancienne version est toujours détectée"}
                              {status === 'ok' && item?.verification === 'unverifiable'   && 'Mis à jour (la version ne peut pas être vérifiée)'}
                              {status === 'ok' && !item?.verification                     && 'Mis à jour'}
                              {status === 'error'      && (item?.reason ?? 'Échec de la mise à jour')}
                            </p>
                            {swInstall === 'idle' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); hideSw(pkg); }}
                                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-700 transition-colors mt-0.5"
                              >
                                <EyeOff className="h-3 w-3" />
                                Ne plus proposer
                              </button>
                            )}
                            {status === 'error' && item?.kind === 'needs_permission' && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  setSwItemStatus(prev => new Map(prev).set(pkg.id, { status: 'installing' }));
                                  const result = await invoke<ElevatedInstallResult>('updates_install_elevated', { pkg: { id: pkg.id, name: pkg.name, currentVersion: pkg.currentVersion } });
                                  if (result.logFile) setLogFile(result.logFile);
                                  setSwItemStatus(prev => new Map(prev).set(pkg.id, {
                                    status: result.ok ? 'ok' : 'error',
                                    reason: result.reason,
                                    kind: result.kind,
                                    reboot: result.reboot,
                                    verification: result.verification,
                                  }));
                                }}
                                className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-900 transition-colors mt-0.5"
                              >
                                Réessayer avec autorisation
                              </button>
                            )}
                            {status === 'error' && !item?.closeMsg && item?.kind === 'close_app' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); closeApp(pkg); }}
                                className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-900 transition-colors mt-0.5"
                              >
                                Fermer l'application
                              </button>
                            )}
                            {item?.closeMsg && (
                              <p className="text-xs text-neutral-500 mt-0.5">{item.closeMsg}</p>
                            )}
                          </div>
                        </div>

                        {/* Versions */}
                        <div className="text-right flex-shrink-0 text-sm">
                          {pkg.versionUnknown
                            ? <span className="text-neutral-400 mr-2">Version inconnue</span>
                            : <span className="text-neutral-400 line-through mr-2">{pkg.currentVersion}</span>}
                          <span className="font-semibold">{pkg.availableVersion}</span>
                        </div>
                      </li>
                      </Fragment>
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
                        {okCount > 0 && staleCount > 0 && ' · '}
                        {staleCount > 0 && (
                          <><span className="font-medium">{staleCount}</span> à vérifier</>
                        )}
                        {(okCount > 0 || staleCount > 0) && errCount > 0 && ' · '}
                        {errCount > 0 && (
                          <><span className="font-medium">{errCount}</span> échec{errCount > 1 ? 's' : ''}</>
                        )}
                      </p>
                      {logFile && (
                        <button
                          onClick={() => invoke('shell_open_log', { path: logFile })}
                          className="text-sm text-neutral-500 underline underline-offset-2 hover:text-neutral-900 transition-colors"
                        >
                          Voir le rapport
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Logiciels masqués ── */}
          {swInstall === 'idle' && hiddenList.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowHidden(v => !v)}
                className="flex items-center gap-1 text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                {showHidden ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Masqués ({hiddenList.length})
              </button>
              {showHidden && (
                <div className="space-y-2">
                  <p className="text-xs text-neutral-500">
                    Ces programmes ne vous sont plus proposés. Vous pouvez les proposer de nouveau à tout moment.
                  </p>
                  <ul className="space-y-2">
                    {hiddenList.map(pkg => (
                      <li key={pkg.id} className="flex items-center gap-4 p-3 bg-white border border-neutral-200">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{pkg.name}</p>
                          <p className="text-xs text-neutral-400 truncate">{pkg.id}</p>
                        </div>
                        <span className="text-xs text-neutral-500 flex-shrink-0">
                          {pkg.versionUnknown ? 'Version inconnue' : pkg.currentVersion} → {pkg.availableVersion}
                        </span>
                        <button
                          onClick={() => unhideSw(pkg)}
                          className="text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-900 transition-colors flex-shrink-0"
                        >
                          Proposer à nouveau
                        </button>
                      </li>
                    ))}
                  </ul>
                  {hiddenList.length > 1 && (
                    <button
                      onClick={unhideAllSw}
                      className="text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-900 transition-colors"
                    >
                      Tout proposer à nouveau
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {hideError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{hideError}</span>
            </div>
          )}

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
                <span>Analyse impossible — {drError}</span>
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
