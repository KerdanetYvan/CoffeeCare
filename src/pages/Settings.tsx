import { useEffect, useState } from 'react';
import { Moon, Rocket, Info, Sparkles, Globe, Clock, BarChart2, ExternalLink } from 'lucide-react';

function SectionDivider() {
  return <div className="border-t border-neutral-200" />;
}

interface ToggleRowProps {
  label:       string;
  description: string;
  checked:     boolean;
  onChange?:   (v: boolean) => void;
  disabled?:   boolean;
  loading?:    boolean;
}

function ToggleRow({ label, description, checked, onChange, disabled = false, loading = false }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-6 py-1">
      <div>
        <p className={['font-medium text-sm', disabled ? 'text-neutral-400' : 'text-neutral-900'].join(' ')}>
          {label}
        </p>
        <p className="text-xs text-neutral-400 mt-0.5">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled || loading}
        onClick={() => onChange?.(!checked)}
        className={[
          'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
          disabled || loading ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
          checked && !disabled ? 'bg-neutral-900' : 'bg-neutral-300',
        ].join(' ')}
      >
        <span className={[
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')} />
      </button>
    </div>
  );
}

export default function Settings() {
  const [version,     setVersion]     = useState<string>('…');
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [toggling,    setToggling]    = useState(false);

  useEffect(() => {
    window.api.getSettingsInfo().then(info => {
      setVersion(info.version);
      setOpenAtLogin(info.openAtLogin);
    });
  }, []);

  const handleLoginItem = async (v: boolean) => {
    setToggling(true);
    setOpenAtLogin(v);
    await window.api.setLoginItem(v);
    setToggling(false);
  };

  return (
    <section className="space-y-8">

      <div>
        <h1 className="text-2xl font-semibold">Paramètres</h1>
        <p className="text-sm text-neutral-500 mt-0.5">Personnalisez le comportement de Cleaner PC</p>
      </div>

      {/* ══ Apparence ══════════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Moon className="h-5 w-5 text-neutral-600" />
          <h2 className="text-lg font-semibold">Apparence</h2>
        </div>
        <ToggleRow
          label="Thème sombre"
          description="Réduire la luminosité de l'interface pour un confort de lecture en basse lumière"
          checked={false}
          disabled={true}
        />
      </div>

      <SectionDivider />

      {/* ══ Démarrage ══════════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-neutral-600" />
          <h2 className="text-lg font-semibold">Démarrage</h2>
        </div>
        <ToggleRow
          label="Lancer Cleaner PC au démarrage de Windows"
          description="L'application démarre automatiquement quand vous allumez votre PC"
          checked={openAtLogin}
          onChange={handleLoginItem}
          loading={toggling}
        />
      </div>

      <SectionDivider />

      {/* ══ À propos ═══════════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Info className="h-5 w-5 text-neutral-600" />
          <h2 className="text-lg font-semibold">À propos</h2>
        </div>
        <div className="flex items-center justify-between py-1">
          <p className="text-sm text-neutral-500">Version</p>
          <span className="text-sm font-medium text-neutral-700">{version}</span>
        </div>
      </div>

      <SectionDivider />

      {/* ══ Fonctionnalités à venir ════════════════════════════════════════════ */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-neutral-600" />
          <h2 className="text-lg font-semibold">Bientôt disponible</h2>
        </div>
        <p className="text-sm text-neutral-500">
          Ces fonctionnalités sont en cours de développement et seront ajoutées dans une prochaine version.
        </p>
        <div className="bg-neutral-50 border border-neutral-200 rounded-lg divide-y divide-neutral-200">
          {[
            { icon: Moon,         label: 'Thème sombre',             detail: 'Interface adaptée aux environnements sombres' },
            { icon: Globe,        label: 'Langues supplémentaires',   detail: 'Anglais, espagnol et plus encore' },
            { icon: Clock,        label: 'Nettoyage automatique',     detail: 'Planifiez un nettoyage régulier sans y penser' },
            { icon: BarChart2,    label: 'Rapports d\'utilisation',   detail: 'Statistiques anonymes pour améliorer Cleaner PC (opt-in)' },
            { icon: ExternalLink, label: 'Espace en ligne',           detail: 'Compte Cleaner PC, synchronisation et fonctionnalités premium' },
          ].map(({ icon: Icon, label, detail }) => (
            <div key={label} className="flex items-center gap-4 px-4 py-3">
              <Icon className="h-4 w-4 text-neutral-400 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-neutral-600">{label}</p>
                <p className="text-xs text-neutral-400 mt-0.5">{detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

    </section>
  );
}
