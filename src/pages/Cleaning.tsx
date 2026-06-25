import { useState } from 'react';
import { ShieldAlert, Trash2, ScanSearch, CheckSquare, Square } from 'lucide-react';
import type { TempDir, CleanResult } from '../types/electron-api';

type Phase = 'idle' | 'scanning' | 'results' | 'cleaning' | 'done';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} Go`;
}

export default function Cleaning() {
  const [phase, setPhase]           = useState<Phase>('idle');
  const [dirs, setDirs]             = useState<TempDir[]>([]);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [cleanResult, setCleanResult] = useState<CleanResult | null>(null);

  const scan = async () => {
    setPhase('scanning');
    setDirs([]);
    setSelected(new Set());
    setCleanResult(null);

    const res = await window.api.getTempDirs();
    const found = res.data.filter(d => d.fileCount > 0);

    setDirs(found);
    setSelected(new Set(found.map(d => d.path)));
    setPhase('results');
  };

  const toggleAll = () => {
    if (selected.size === dirs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(dirs.map(d => d.path)));
    }
  };

  const toggle = (dirPath: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const clean = async () => {
    if (selected.size === 0) return;
    setPhase('cleaning');

    const paths = [...selected];
    const hasAdmin = dirs.some(d => d.requiresAdmin && selected.has(d.path));

    if (hasAdmin) {
      // Informer l'utilisateur avant le popup UAC
      await new Promise(r => setTimeout(r, 100));
    }

    const result = await window.api.deleteDirs(paths);
    setCleanResult(result);
    setPhase('done');
  };

  const reset = () => {
    setPhase('idle');
    setDirs([]);
    setSelected(new Set());
    setCleanResult(null);
  };

  const selectedDirs  = dirs.filter(d => selected.has(d.path));
  const totalSelected = selectedDirs.reduce((acc, d) => acc + d.sizeBytes, 0);
  const hasAdmin      = selectedDirs.some(d => d.requiresAdmin);

  return (
    <section className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Nettoyage</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Analyse et suppression des fichiers temporaires et caches
          </p>
        </div>

        {phase === 'idle' || phase === 'done' ? (
          <button
            onClick={scan}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
          >
            <ScanSearch className="h-4 w-4" />
            {phase === 'done' ? 'Rescanner' : 'Scanner'}
          </button>
        ) : null}
      </div>

      {/* Scanning */}
      {phase === 'scanning' && (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900" />
          <p className="text-neutral-500">Analyse en cours…</p>
        </div>
      )}

      {/* Cleaning */}
      {phase === 'cleaning' && (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-neutral-900" />
          <p className="text-neutral-500">Nettoyage en cours…</p>
          {hasAdmin && (
            <p className="text-sm text-amber-600 text-center max-w-sm">
              Une fenêtre s'est ouverte pour nettoyer les dossiers système.
              Cliquez sur <strong>Oui</strong> à la demande de l'UAC.
            </p>
          )}
        </div>
      )}

      {/* Results list */}
      {(phase === 'results' || phase === 'done') && dirs.length > 0 && (
        <>
          {/* Select all */}
          <div className="flex items-center gap-3 pb-2 border-b border-neutral-200">
            <button onClick={toggleAll} className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors">
              {selected.size === dirs.length
                ? <CheckSquare className="h-4 w-4 text-neutral-900" />
                : <Square className="h-4 w-4" />}
              Tout sélectionner
            </button>
            <span className="text-neutral-300">|</span>
            <span className="text-sm text-neutral-500">{dirs.length} dossier{dirs.length > 1 ? 's' : ''} trouvé{dirs.length > 1 ? 's' : ''}</span>
          </div>

          {/* Dir list */}
          <ul className="space-y-2">
            {dirs.map(dir => {
              const isSelected = selected.has(dir.path);
              return (
                <li
                  key={dir.path}
                  onClick={() => { if (phase === 'results') toggle(dir.path); }}
                  className={[
                    'flex items-center gap-4 p-4 border transition-colors',
                    phase === 'results' ? 'cursor-pointer' : 'cursor-default',
                    isSelected
                      ? 'bg-neutral-900/5 border-neutral-900/30'
                      : 'bg-white border-neutral-200 opacity-60',
                  ].join(' ')}
                >
                  <button
                    onClick={e => { e.stopPropagation(); if (phase === 'results') toggle(dir.path); }}
                    className="flex-shrink-0"
                    disabled={phase !== 'results'}
                  >
                    {isSelected
                      ? <CheckSquare className="h-5 w-5 text-neutral-900" />
                      : <Square className="h-5 w-5 text-neutral-400" />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{dir.label}</span>
                      {dir.requiresAdmin && (
                        <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5">
                          <ShieldAlert className="h-3 w-3" />
                          Admin
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-400 truncate mt-0.5">{dir.path}</p>
                  </div>

                  <div className="text-right flex-shrink-0">
                    <p className="font-semibold text-sm">{formatBytes(dir.sizeBytes)}</p>
                    <p className="text-xs text-neutral-400">{dir.fileCount} fichier{dir.fileCount > 1 ? 's' : ''}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Empty scan */}
      {phase === 'results' && dirs.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 text-neutral-400 gap-2">
          <Trash2 className="h-10 w-10" />
          <p>Aucun fichier temporaire détecté.</p>
        </div>
      )}

      {/* Clean result banner */}
      {phase === 'done' && cleanResult && (
        <div className={[
          'p-4 border',
          cleanResult.ok
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-amber-50 border-amber-200 text-amber-800',
        ].join(' ')}>
          <p className="font-medium">
            {cleanResult.ok ? '✓ Nettoyage terminé' : '⚠ Nettoyage partiel'}
          </p>
          <p className="text-sm mt-1">
            {formatBytes(cleanResult.freedBytes)} libérés · {cleanResult.deletedCount} éléments supprimés
            {cleanResult.errorCount > 0 && ` · ${cleanResult.errorCount} erreur${cleanResult.errorCount > 1 ? 's' : ''} (fichiers verrouillés ou accès refusé)`}
          </p>
        </div>
      )}

      {/* Bottom action bar */}
      {phase === 'results' && dirs.length > 0 && (
        <div className="flex items-center justify-between pt-4 border-t border-neutral-200">
          <div className="text-sm text-neutral-600">
            {selected.size > 0 ? (
              <>
                <span className="font-medium">{formatBytes(totalSelected)}</span>
                {' '}à libérer · {selected.size} dossier{selected.size > 1 ? 's' : ''} sélectionné{selected.size > 1 ? 's' : ''}
                {hasAdmin && (
                  <span className="ml-2 text-amber-600 inline-flex items-center gap-1">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Élévation UAC requise
                  </span>
                )}
              </>
            ) : (
              <span className="text-neutral-400">Aucun dossier sélectionné</span>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={reset}
              className="px-4 py-2 text-sm text-neutral-600 border border-neutral-200 hover:bg-neutral-50 transition-colors"
            >
              Annuler
            </button>
            <button
              onClick={clean}
              disabled={selected.size === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-4 w-4" />
              Nettoyer la sélection
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
