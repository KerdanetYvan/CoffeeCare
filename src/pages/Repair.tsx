import { useState } from 'react';
import { ScanSearch, Wrench, CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronUp, ShieldCheck, Clock, Cpu, Database, Rocket, HardDrive } from 'lucide-react';
import type { ServiceInfo, RepairResult, SFCResult, DriverError, DriverErrorScanResult, RegistryIssue, RegistryScanResult, StartupItem, StartupScanResult, StartupChange, DiskDevice } from '../types/electron-api';

// ── Types locaux ──────────────────────────────────────────────────────────────

type SvcPhase = 'idle' | 'scanning' | 'results';
type FixPhase = 'idle' | 'fixing' | 'done';
type SFCPhase = 'idle' | 'running' | 'done';
type DrvPhase = 'idle' | 'scanning' | 'results';

// ── Sous-composants ───────────────────────────────────────────────────────────

function SectionDivider() {
  return <div className="border-t border-neutral-200" />;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'Running') {
    return (
      <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5">
        <CheckCircle className="h-3 w-3" /> Actif
      </span>
    );
  }
  if (status === 'Disabled') {
    return (
      <span className="flex items-center gap-1 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-0.5">
        <XCircle className="h-3 w-3" /> Désactivé
      </span>
    );
  }
  if (status === 'Stopped') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5">
        <AlertCircle className="h-3 w-3" /> À l'arrêt
      </span>
    );
  }
  return (
    <span className="text-xs text-neutral-500 bg-neutral-100 border border-neutral-200 px-2 py-0.5">
      Inconnu
    </span>
  );
}

function ServiceRow({ svc }: { svc: ServiceInfo }) {
  return (
    <li className={[
      'flex items-center gap-4 p-4 border',
      svc.hasIssue ? 'bg-red-50/50 border-red-200' : 'bg-white border-neutral-200',
    ].join(' ')}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{svc.label}</span>
          {svc.hasIssue && <span className="text-xs text-red-600 font-medium">— problème détecté</span>}
        </div>
        <p className="text-xs text-neutral-400 mt-0.5">{svc.description}</p>
      </div>
      <StatusBadge status={svc.status} />
    </li>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────

const SFC_STATUS_LABELS: Record<SFCResult['status'], { label: string; detail: string; color: string }> = {
  healthy:  { label: 'Votre système est en bonne santé',               detail: 'Tous les fichiers essentiels de Windows sont intacts.',                                                              color: 'text-neutral-900 bg-neutral-50 border-neutral-300'  },
  repaired: { label: 'Des problèmes ont été corrigés',                  detail: "Windows a détecté et réparé des fichiers abîmés. Votre PC devrait fonctionner normalement.",                       color: 'text-neutral-900 bg-neutral-50 border-neutral-300'  },
  failed:   { label: "Certains problèmes n'ont pas pu être réglés",    detail: "Windows a trouvé des fichiers abîmés mais n'a pas réussi à tous les réparer. Contactez le support si les problèmes persistent.", color: 'text-neutral-900 bg-neutral-100 border-neutral-500'  },
  unknown:  { label: 'Vérification terminée',                           detail: "La vérification s'est terminée. Relancez une analyse si vous avez des doutes.",                                     color: 'text-neutral-600 bg-neutral-50 border-neutral-200'   },
};

export default function Repair() {

  // ── État : Programmes essentiels ──
  const [svcPhase,  setSvcPhase]  = useState<SvcPhase>('idle');
  const [services,  setServices]  = useState<ServiceInfo[]>([]);
  const [svcError,  setSvcError]  = useState<string | null>(null);
  const [showAll,   setShowAll]   = useState(false);
  const [fixPhase,  setFixPhase]  = useState<FixPhase>('idle');
  const [fixResult, setFixResult] = useState<RepairResult | null>(null);

  // ── État : Fichiers système ──
  const [sfcPhase,  setSfcPhase]  = useState<SFCPhase>('idle');
  const [sfcResult, setSfcResult] = useState<SFCResult | null>(null);

  // ── État : Composants et périphériques ──
  const [drvPhase,    setDrvPhase]    = useState<DrvPhase>('idle');
  const [drivers,     setDrivers]     = useState<DriverError[]>([]);
  const [drvError,    setDrvError]    = useState<string | null>(null);
  const [drvFixPhase, setDrvFixPhase] = useState<FixPhase>('idle');
  const [drvResult,   setDrvResult]   = useState<RepairResult | null>(null);

  // ── État : Registre ──
  const [regPhase,    setRegPhase]    = useState<DrvPhase>('idle');
  const [regIssues,   setRegIssues]   = useState<RegistryIssue[]>([]);
  const [regError,    setRegError]    = useState<string | null>(null);
  const [regFixPhase, setRegFixPhase] = useState<FixPhase>('idle');
  const [regResult,   setRegResult]   = useState<RepairResult | null>(null);

  // ── État : Démarrage ──
  const [stpPhase,    setStpPhase]    = useState<DrvPhase>('idle');
  const [stpOriginal, setStpOriginal] = useState<StartupItem[]>([]);
  const [stpItems,    setStpItems]    = useState<StartupItem[]>([]);
  const [stpError,    setStpError]    = useState<string | null>(null);
  const [stpApplying, setStpApplying] = useState(false);
  const [stpApplied,  setStpApplied]  = useState(false);

  // ── État : Disque ──
  const [diskPhase,     setDiskPhase]     = useState<DrvPhase>('idle');
  const [diskDevices,   setDiskDevices]   = useState<DiskDevice[]>([]);
  const [diskError,     setDiskError]     = useState<string | null>(null);
  const [diskScheduled, setDiskScheduled] = useState(false);
  const [diskScheduling,setDiskScheduling]= useState(false);

  // ── Actions ──

  const scanServices = async () => {
    setSvcPhase('scanning');
    setSvcError(null);
    setFixPhase('idle');
    setFixResult(null);
    setShowAll(false);
    const res = await window.api.getServices();
    setServices(res.data);
    setSvcError(res.ok ? null : (res.error ?? 'Erreur inconnue'));
    setSvcPhase('results');
  };

  const fixServices = async () => {
    const toFix = services.filter(s => s.hasIssue).map(s => s.name);
    if (toFix.length === 0) return;
    setFixPhase('fixing');
    const result = await window.api.fixServices(toFix);
    setFixResult(result);
    setFixPhase('done');
  };

  const runSFC = async () => {
    setSfcPhase('running');
    setSfcResult(null);
    const result = await window.api.runSFC();
    setSfcResult(result);
    setSfcPhase('done');
  };

  const scanDrivers = async () => {
    setDrvPhase('scanning');
    setDrvError(null);
    setDrvFixPhase('idle');
    setDrvResult(null);
    const res: DriverErrorScanResult = await window.api.getDriverErrors();
    setDrivers(res.data);
    setDrvError(res.ok ? null : (res.error ?? 'Erreur inconnue'));
    setDrvPhase('results');
  };

  const fixDrivers = async () => {
    const ids = drivers.map(d => d.instanceId);
    if (ids.length === 0) return;
    setDrvFixPhase('fixing');
    const result = await window.api.fixDriverErrors(ids);
    setDrvResult(result);
    setDrvFixPhase('done');
  };

  const scanStartup = async () => {
    setStpPhase('scanning');
    setStpError(null);
    setStpApplying(false);
    setStpApplied(false);
    const res: StartupScanResult = await window.api.getStartupItems();
    setStpOriginal(res.data);
    setStpItems(res.data.map(i => ({ ...i })));
    setStpError(res.ok ? null : (res.error ?? 'Erreur inconnue'));
    setStpPhase('results');
  };

  const toggleStartup = (name: string) => {
    setStpItems(prev => prev.map(i => i.name === name ? { ...i, enabled: !i.enabled } : i));
    setStpApplied(false);
  };

  const applyStartup = async () => {
    const changes: StartupChange[] = stpItems
      .filter(item => {
        const orig = stpOriginal.find(o => o.name === item.name);
        return orig && orig.enabled !== item.enabled;
      })
      .map(item => ({ name: item.name, source: item.source, enabled: item.enabled }));

    if (changes.length === 0) return;
    setStpApplying(true);
    const res = await window.api.setStartupItems(changes);
    setStpApplying(false);
    if (res.ok) {
      setStpOriginal(stpItems.map(i => ({ ...i })));
      setStpApplied(true);
    }
  };

  const stpChanges = stpItems.filter(item => {
    const orig = stpOriginal.find(o => o.name === item.name);
    return orig && orig.enabled !== item.enabled;
  });

  const scanDisk = async () => {
    setDiskPhase('scanning');
    setDiskError(null);
    setDiskScheduled(false);
    const res = await window.api.getDiskHealth();
    setDiskDevices(res.disks);
    setDiskError(res.ok ? null : (res.error ?? 'Erreur inconnue'));
    setDiskPhase('results');
  };

  const scheduleDisk = async () => {
    const letters = diskDevices
      .filter(d => d.healthStatus !== 'Healthy')
      .flatMap(d => d.volumes.map(v => v.letter));
    const toSchedule = letters.length > 0 ? letters : ['C'];
    setDiskScheduling(true);
    const res = await window.api.scheduleDiskCheck(toSchedule);
    setDiskScheduling(false);
    setDiskScheduled(res.ok);
  };

  const diskStatusLabel = (s: string) =>
    s === 'Healthy' ? 'En bonne santé' : s === 'Warning' ? 'À surveiller' : s === 'Unhealthy' ? 'Problème détecté' : s;

  const diskHeaderColor = (s: string) =>
    s === 'Healthy'
      ? 'border-green-200 bg-green-50/60'
      : s === 'Warning'
      ? 'border-amber-200 bg-amber-50/60'
      : 'border-red-200 bg-red-50/60';

  const hasUnhealthyDisk = diskDevices.some(d => d.healthStatus !== 'Healthy');

  const scanRegistry = async () => {
    setRegPhase('scanning');
    setRegError(null);
    setRegFixPhase('idle');
    setRegResult(null);
    const res: RegistryScanResult = await window.api.getRegistryIssues();
    setRegIssues(res.data);
    setRegError(res.ok ? null : (res.error ?? 'Erreur inconnue'));
    setRegPhase('results');
  };

  const fixRegistry = async () => {
    const paths = regIssues.map(r => r.registryPath);
    if (paths.length === 0) return;
    setRegFixPhase('fixing');
    const result = await window.api.fixRegistryIssues(paths);
    setRegResult(result);
    setRegFixPhase('done');
  };

  const issues  = services.filter(s => s.hasIssue);
  const healthy = services.filter(s => !s.hasIssue);

  return (
    <section className="space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Réparation</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          Diagnostic et correctifs des composants système
        </p>
      </div>

      {/* ══ Programmes essentiels ══════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-neutral-600" />
            <h2 className="text-lg font-semibold">Programmes essentiels</h2>
            {svcPhase === 'results' && issues.length > 0 && (
              <span className="text-xs bg-red-500 text-white px-2 py-0.5">
                {issues.length} problème{issues.length > 1 ? 's' : ''}
              </span>
            )}
            {svcPhase === 'results' && issues.length === 0 && (
              <span className="text-xs bg-green-500 text-white px-2 py-0.5">
                Tout est OK
              </span>
            )}
          </div>
          {svcPhase !== 'scanning' && (
            <button
              onClick={scanServices}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <ScanSearch className="h-4 w-4" />
              {svcPhase === 'results' ? 'Rescanner' : 'Analyser'}
            </button>
          )}
        </div>

        <p className="text-sm text-neutral-500">
          Windows s'appuie sur des programmes invisibles qui tournent en arrière-plan.
          Cette analyse vérifie qu'ils fonctionnent tous correctement.
        </p>

        {svcPhase === 'scanning' && (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
            <p className="text-sm text-neutral-500">Analyse en cours…</p>
          </div>
        )}

        {svcPhase === 'results' && (
          <>
            {svcError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>Impossible d'effectuer l'analyse. Réessayez.</span>
              </div>
            )}

            {issues.length > 0 && (
              <ul className="space-y-2">
                {issues.map(svc => <ServiceRow key={svc.name} svc={svc} />)}
              </ul>
            )}

            {healthy.length > 0 && (
              <div className="space-y-2">
                <button
                  onClick={() => setShowAll(v => !v)}
                  className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
                >
                  {showAll
                    ? <><ChevronUp className="h-4 w-4" /> Masquer les programmes actifs</>
                    : <><ChevronDown className="h-4 w-4" /> Afficher les {healthy.length} programmes actifs</>}
                </button>
                {showAll && (
                  <ul className="space-y-2">
                    {healthy.map(svc => <ServiceRow key={svc.name} svc={svc} />)}
                  </ul>
                )}
              </div>
            )}

            {fixPhase === 'idle' && issues.length > 0 && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-sm text-neutral-500">
                  Windows va vous demander l'autorisation, cliquez sur <strong>Oui</strong>.
                </p>
                <button
                  onClick={fixServices}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                >
                  <Wrench className="h-4 w-4" />
                  Corriger les problèmes
                </button>
              </div>
            )}

            {fixPhase === 'fixing' && (
              <div className="flex items-center gap-3 pt-1">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                <p className="text-sm text-neutral-600">
                  Correction en cours… Windows va vous demander l'autorisation, cliquez sur Oui.
                </p>
              </div>
            )}

            {fixPhase === 'done' && fixResult && (
              <div className={[
                'p-3 border text-sm',
                fixResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800',
              ].join(' ')}>
                {fixResult.ok
                  ? `✓ ${fixResult.fixed} programme${fixResult.fixed > 1 ? 's relancés' : ' relancé'} — relancez l'analyse pour vérifier`
                  : '⚠ Certains programmes n\'ont pas pu être relancés'}
              </div>
            )}
          </>
        )}
      </div>

      <SectionDivider />

      {/* ══ Fichiers système ═══════════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-neutral-600" />
          <h2 className="text-lg font-semibold">Fichiers système</h2>
        </div>

        <p className="text-sm text-neutral-500">
          Windows va inspecter ses propres fichiers essentiels et réparer automatiquement
          ceux qui seraient abîmés ou manquants. Recommandé si votre PC rencontre des
          problèmes inexpliqués.
        </p>

        <div className="flex items-center gap-2 text-xs text-neutral-600 bg-neutral-50 border border-neutral-300 px-3 py-2">
          <Clock className="h-3.5 w-3.5 flex-shrink-0" />
          La vérification prend <strong className="mx-1">10 à 15 minutes</strong>.
          Windows vous demandera l'autorisation — cliquez sur <strong className="ml-1">Oui</strong>.
        </div>

        {sfcPhase === 'idle' && (
          <button
            onClick={runSFC}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
          >
            <ShieldCheck className="h-4 w-4" />
            Vérifier les fichiers système
          </button>
        )}

        {sfcPhase === 'running' && (
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
            <div>
              <p className="text-sm text-neutral-700 font-medium">Vérification en cours…</p>
              <p className="text-xs text-neutral-400">Ne fermez pas l'application. Cela peut prendre jusqu'à 15 minutes.</p>
            </div>
          </div>
        )}

        {sfcPhase === 'done' && sfcResult && (() => {
          const meta = SFC_STATUS_LABELS[sfcResult.status];
          return (
            <div className="space-y-2">
              <div className={`flex items-start gap-2 p-3 border text-sm ${meta.color}`}>
                <CheckCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">{meta.label}</p>
                  <p className="mt-0.5 opacity-80">{meta.detail}</p>
                </div>
              </div>
              <button
                onClick={() => { setSfcPhase('idle'); setSfcResult(null); }}
                className="text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                Relancer la vérification
              </button>
            </div>
          );
        })()}
      </div>

      <SectionDivider />

      {/* ══ Composants et périphériques ════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-neutral-600" />
            <h2 className="text-lg font-semibold">Composants et périphériques</h2>
            {drvPhase === 'results' && drivers.length > 0 && (
              <span className="text-xs bg-red-500 text-white px-2 py-0.5">
                {drivers.length} problème{drivers.length > 1 ? 's' : ''}
              </span>
            )}
            {drvPhase === 'results' && drivers.length === 0 && (
              <span className="text-xs bg-green-500 text-white px-2 py-0.5">
                Tout est OK
              </span>
            )}
          </div>
          {drvPhase !== 'scanning' && (
            <button
              onClick={scanDrivers}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <ScanSearch className="h-4 w-4" />
              {drvPhase === 'results' ? 'Rescanner' : 'Analyser'}
            </button>
          )}
        </div>

        <p className="text-sm text-neutral-500">
          Vérifiez si la carte graphique, la carte son, les ports USB et les autres
          composants de votre PC fonctionnent sans problème.
        </p>

        {drvPhase === 'scanning' && (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
            <p className="text-sm text-neutral-500">Analyse des composants…</p>
          </div>
        )}

        {drvPhase === 'results' && (
          <>
            {drvError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>Impossible d'effectuer l'analyse. Réessayez.</span>
              </div>
            )}

            {!drvError && drivers.length === 0 && (
              <p className="text-sm text-neutral-400 py-2">
                Tous vos composants fonctionnent correctement.
              </p>
            )}

            {drivers.length > 0 && (
              <ul className="space-y-2">
                {drivers.map(d => (
                  <li
                    key={d.instanceId}
                    className="flex items-center gap-4 p-4 border bg-red-50/50 border-red-200"
                  >
                    <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{d.name}</p>
                      <p className="text-xs text-neutral-400 mt-0.5">Problème détecté — ce composant ne fonctionne pas correctement</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {drvFixPhase === 'idle' && drivers.length > 0 && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-sm text-neutral-500">
                  CoffeeCare va tenter de relancer ces composants. Windows vous demandera l'autorisation.
                </p>
                <button
                  onClick={fixDrivers}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                >
                  <Wrench className="h-4 w-4" />
                  Relancer les composants
                </button>
              </div>
            )}

            {drvFixPhase === 'fixing' && (
              <div className="flex items-center gap-3 pt-1">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                <p className="text-sm text-neutral-600">
                  Relance en cours… Windows va vous demander l'autorisation, cliquez sur Oui.
                </p>
              </div>
            )}

            {drvFixPhase === 'done' && drvResult && (
              <div className={[
                'p-3 border text-sm',
                drvResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800',
              ].join(' ')}>
                {drvResult.ok
                  ? '✓ Les composants ont été relancés. Si le problème persiste, un redémarrage du PC peut aider.'
                  : '⚠ Certains composants n\'ont pas pu être relancés. Un redémarrage du PC peut aider.'}
              </div>
            )}
          </>
        )}
      </div>

      <SectionDivider />

      {/* ══ Registre ═══════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-neutral-600" />
            <h2 className="text-lg font-semibold">Programmes fantômes</h2>
            {regPhase === 'results' && regIssues.length > 0 && (
              <span className="text-xs bg-red-500 text-white px-2 py-0.5">
                {regIssues.length} entrée{regIssues.length > 1 ? 's' : ''}
              </span>
            )}
            {regPhase === 'results' && regIssues.length === 0 && (
              <span className="text-xs bg-green-500 text-white px-2 py-0.5">
                Tout est OK
              </span>
            )}
          </div>
          {regPhase !== 'scanning' && (
            <button
              onClick={scanRegistry}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <ScanSearch className="h-4 w-4" />
              {regPhase === 'results' ? 'Rescanner' : 'Analyser'}
            </button>
          )}
        </div>

        <p className="text-sm text-neutral-500">
          Quand un programme est mal désinstallé, il peut laisser une trace dans Windows
          et continuer à apparaître dans la liste des programmes installés alors qu'il n'existe
          plus sur votre PC. CoffeeCare peut détecter et supprimer ces entrées obsolètes.
        </p>

        {regPhase === 'scanning' && (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
            <p className="text-sm text-neutral-500">Analyse en cours…</p>
          </div>
        )}

        {regPhase === 'results' && (
          <>
            {regError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>Impossible d'effectuer l'analyse. Réessayez.</span>
              </div>
            )}

            {!regError && regIssues.length === 0 && (
              <p className="text-sm text-neutral-400 py-2">
                Aucun programme fantôme détecté.
              </p>
            )}

            {regIssues.length > 0 && (
              <ul className="space-y-2">
                {regIssues.map(r => (
                  <li key={r.registryPath} className="flex items-center gap-4 p-4 border bg-amber-50/50 border-amber-200">
                    <AlertCircle className="h-5 w-5 text-amber-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{r.name}</p>
                      <p className="text-xs text-neutral-400 mt-0.5 truncate">
                        Dossier introuvable : {r.installLocation}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {regFixPhase === 'idle' && regIssues.length > 0 && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-sm text-neutral-500">
                  {regIssues.length} entrée{regIssues.length > 1 ? 's' : ''} à supprimer — Windows vous demandera l'autorisation.
                </p>
                <button
                  onClick={fixRegistry}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                >
                  <Wrench className="h-4 w-4" />
                  Nettoyer les entrées obsolètes
                </button>
              </div>
            )}

            {regFixPhase === 'fixing' && (
              <div className="flex items-center gap-3 pt-1">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                <p className="text-sm text-neutral-600">
                  Nettoyage en cours… Windows va vous demander l'autorisation, cliquez sur Oui.
                </p>
              </div>
            )}

            {regFixPhase === 'done' && regResult && (
              <div className={[
                'p-3 border text-sm',
                regResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800',
              ].join(' ')}>
                {regResult.ok
                  ? `✓ ${regResult.fixed} entrée${regResult.fixed > 1 ? 's supprimées' : ' supprimée'} — votre liste de programmes est à jour`
                  : '⚠ Certaines entrées n\'ont pas pu être supprimées'}
              </div>
            )}
          </>
        )}
      </div>

      <SectionDivider />

      {/* ══ Programmes au démarrage ════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-neutral-600" />
            <h2 className="text-lg font-semibold">Programmes au démarrage</h2>
            {stpPhase === 'results' && stpChanges.length > 0 && (
              <span className="text-xs bg-neutral-900 text-white px-2 py-0.5">
                {stpChanges.length} modification{stpChanges.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          {stpPhase !== 'scanning' && !stpApplying && (
            <button
              onClick={scanStartup}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <ScanSearch className="h-4 w-4" />
              {stpPhase === 'results' ? 'Rescanner' : 'Analyser'}
            </button>
          )}
        </div>

        <p className="text-sm text-neutral-500">
          Ces programmes se lancent automatiquement à chaque démarrage de votre PC.
          En désactiver certains peut accélérer le démarrage. Vous pouvez les réactiver à tout moment.
        </p>

        {stpPhase === 'scanning' && (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
            <p className="text-sm text-neutral-500">Analyse en cours…</p>
          </div>
        )}

        {stpPhase === 'results' && (
          <>
            {stpError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>Impossible d'effectuer l'analyse. Réessayez.</span>
              </div>
            )}

            {!stpError && stpItems.length === 0 && (
              <p className="text-sm text-neutral-400 py-2">Aucun programme de démarrage automatique trouvé.</p>
            )}

            {stpItems.length > 0 && (
              <ul className="space-y-2">
                {stpItems.map(item => (
                  <li
                    key={item.name}
                    className={[
                      'flex items-center gap-4 p-4 border transition-colors',
                      item.enabled ? 'bg-white border-neutral-200' : 'bg-neutral-50 border-neutral-200 opacity-60',
                    ].join(' ')}
                  >
                    <button
                      onClick={() => toggleStartup(item.name)}
                      disabled={stpApplying}
                      className={[
                        'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                        item.enabled ? 'bg-neutral-900' : 'bg-neutral-300',
                        stpApplying ? 'cursor-not-allowed' : 'cursor-pointer',
                      ].join(' ')}
                      role="switch"
                      aria-checked={item.enabled}
                    >
                      <span className={[
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200',
                        item.enabled ? 'translate-x-4' : 'translate-x-0',
                      ].join(' ')} />
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{item.name}</span>
                        {item.source === 'system' && (
                          <span className="text-xs text-neutral-400 bg-neutral-100 px-1.5 py-0.5">Système</span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-400 truncate mt-0.5">{item.command}</p>
                    </div>

                    <span className={[
                      'text-xs flex-shrink-0',
                      item.enabled ? 'text-green-600' : 'text-neutral-400',
                    ].join(' ')}>
                      {item.enabled ? 'Actif' : 'Désactivé'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {stpChanges.length > 0 && !stpApplying && (
              <div className="flex items-center justify-between pt-2">
                <p className="text-sm text-neutral-500">
                  {stpChanges.length} modification{stpChanges.length > 1 ? 's' : ''} en attente — Windows vous demandera l'autorisation.
                </p>
                <button
                  onClick={applyStartup}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                >
                  <CheckCircle className="h-4 w-4" />
                  Appliquer les modifications
                </button>
              </div>
            )}

            {stpApplying && (
              <div className="flex items-center gap-3 pt-2">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                <p className="text-sm text-neutral-600">Application en cours… cliquez sur Oui si Windows vous le demande.</p>
              </div>
            )}

            {stpApplied && stpChanges.length === 0 && (
              <div className="p-3 border bg-green-50 border-green-200 text-green-800 text-sm">
                ✓ Modifications enregistrées. Les changements prendront effet au prochain démarrage.
              </div>
            )}
          </>
        )}
      </div>

      <SectionDivider />

      {/* ══ Disque dur ═════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-neutral-600" />
            <h2 className="text-lg font-semibold">Disque dur</h2>
            {diskPhase === 'results' && !hasUnhealthyDisk && (
              <span className="text-xs bg-green-500 text-white px-2 py-0.5">En bonne santé</span>
            )}
            {diskPhase === 'results' && hasUnhealthyDisk && (
              <span className="text-xs bg-amber-500 text-white px-2 py-0.5">À vérifier</span>
            )}
          </div>
          {diskPhase !== 'scanning' && !diskScheduling && (
            <button
              onClick={scanDisk}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
            >
              <ScanSearch className="h-4 w-4" />
              {diskPhase === 'results' ? 'Rescanner' : 'Analyser'}
            </button>
          )}
        </div>

        <p className="text-sm text-neutral-500">
          Vérifiez l'état de santé de votre disque dur. Si des anomalies sont détectées,
          CoffeeCare peut programmer une vérification approfondie au prochain démarrage.
        </p>

        {diskPhase === 'scanning' && (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
            <p className="text-sm text-neutral-500">Analyse du disque…</p>
          </div>
        )}

        {diskPhase === 'results' && (
          <>
            {diskError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>Impossible d'analyser le disque. Réessayez.</span>
              </div>
            )}

            {diskDevices.length > 0 && (
              <ul className="space-y-3">
                {diskDevices.map((disk, i) => (
                  <li key={i} className={`border overflow-hidden ${diskHeaderColor(disk.healthStatus)}`}>
                    {/* En-tête disque physique */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <HardDrive className="h-4 w-4 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{disk.name}</p>
                        <p className="text-xs opacity-70">{disk.sizeGB} Go</p>
                      </div>
                      <span className="text-xs font-medium flex-shrink-0">
                        {diskStatusLabel(disk.healthStatus)}
                      </span>
                    </div>

                    {/* Volumes (partitions) du disque */}
                    {disk.volumes.length > 0 && (
                      <ul className="border-t border-black/5 divide-y divide-black/5">
                        {disk.volumes.map(v => (
                          <li key={v.letter} className="flex items-center gap-3 px-4 py-2.5 bg-white/70">
                            <span className="text-sm font-bold text-neutral-400 w-6 text-center flex-shrink-0">
                              {v.letter}:
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium">{v.label}</p>
                              <p className="text-xs text-neutral-400">{v.freeGB} Go libres sur {v.sizeGB} Go</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {!diskScheduled && !diskScheduling && (
              <div className="flex items-center justify-between pt-1">
                <p className="text-sm text-neutral-500">
                  {hasUnhealthyDisk
                    ? 'Des anomalies ont été détectées. Une vérification approfondie est recommandée.'
                    : 'Tout semble normal. Vous pouvez tout de même programmer une vérification.'}
                </p>
                <button
                  onClick={scheduleDisk}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors flex-shrink-0 ml-4"
                >
                  <HardDrive className="h-4 w-4" />
                  Programmer une vérification
                </button>
              </div>
            )}

            {diskScheduling && (
              <div className="flex items-center gap-3 pt-1">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neutral-900 flex-shrink-0" />
                <p className="text-sm text-neutral-600">Programmation en cours… cliquez sur Oui si Windows vous le demande.</p>
              </div>
            )}

            {diskScheduled && (
              <div className="p-3 border bg-green-50 border-green-200 text-green-800 text-sm">
                ✓ Vérification programmée — elle démarrera automatiquement au prochain redémarrage de votre PC.
              </div>
            )}
          </>
        )}
      </div>

    </section>
  );
}
