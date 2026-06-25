import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Cpu, Wrench, Brush, RefreshCw, Settings, Minus, Square, X, Coffee } from 'lucide-react';

const nav = [
  { to: '/',          label: 'Dashboard',    icon: Cpu      },
  { to: '/cleaning',  label: 'Nettoyage',    icon: Brush    },
  { to: '/repair',    label: 'Réparation',   icon: Wrench   },
  { to: '/updates',   label: 'Mises à jour', icon: RefreshCw },
  { to: '/settings',  label: 'Paramètres',   icon: Settings },
];

export default function MainLayout() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const check = async () => setMaximized(await window.api.isMaximized());
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col select-none overflow-hidden">

      {/* ── Barre de titre ── */}
      <header className="drag-region flex items-center h-10 bg-neutral-900 text-white flex-shrink-0">
        {/* Logo + nom */}
        <div className="flex items-center gap-2 px-4 pointer-events-none">
          <Coffee className="h-4 w-4 text-neutral-400" />
          <span className="text-sm font-semibold tracking-wide">CoffeeCare</span>
        </div>

        {/* Zone extensible (draggable) */}
        <div className="flex-1" />

        {/* Boutons fenêtre */}
        <div className="no-drag-region flex h-full">
          <button
            onClick={() => window.api.minimizeWindow()}
            className="flex items-center justify-center w-11 h-full hover:bg-neutral-700 transition-colors"
            aria-label="Réduire"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.api.maximizeWindow()}
            className="flex items-center justify-center w-11 h-full hover:bg-neutral-700 transition-colors"
            aria-label={maximized ? 'Restaurer' : 'Agrandir'}
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            onClick={() => window.api.closeWindow()}
            className="flex items-center justify-center w-11 h-full hover:bg-red-500 transition-colors"
            aria-label="Fermer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* ── Corps principal ── */}
      <div className="flex flex-1 min-h-0">

        {/* Sidebar */}
        <aside className="w-52 flex-shrink-0 flex flex-col bg-white border-r border-neutral-200">
          <nav className="flex-1 p-3">
            <ul className="space-y-0.5">
              {nav.map(({ to, label, icon: Icon }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    end={to === '/'}
                    className={({ isActive }) =>
                      [
                        'flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-neutral-900 text-white'
                          : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900',
                      ].join(' ')
                    }
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    <span>{label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        {/* Zone de contenu */}
        <main className="flex-1 overflow-auto bg-neutral-50">
          <div className="max-w-5xl mx-auto p-6">
            <Outlet />
          </div>
        </main>

      </div>
    </div>
  );
}
