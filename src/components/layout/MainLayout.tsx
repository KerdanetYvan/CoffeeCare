import { NavLink, Outlet } from "react-router-dom";
import { Cpu, Wrench, Brush, RefreshCw, Settings } from "lucide-react";

const nav = [
  { to: "/", label: "Dashboard", icon: Cpu },
  { to: "/cleaning", label: "Nettoyage", icon: Brush },
  { to: "/repair", label: "Réparation", icon: Wrench },
  { to: "/updates", label: "Mises à jour", icon: RefreshCw },
  { to: "/settings", label: "Paramètres", icon: Settings },
];

export default function MainLayout() {
  return (
    <div className="h-screen w-screen grid grid-cols-[240px_1fr] grid-rows-[56px_1fr]">
      <header className="col-span-2 border-b bg-white/70 backdrop-blur">
        <div className="h-14 flex items-center justify-between px-4">
          <span className="font-semibold">CoffeeCare</span>
        </div>
      </header>

      <aside className="border-r bg-white">
        <nav className="p-2">
          <ul className="space-y-1">
            {nav.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    [
                      "flex items-center gap-2 rounded-xl px-3 py-2 transition",
                      isActive
                        ? "bg-neutral-900 text-white"
                        : "hover:bg-neutral-100 text-neutral-700",
                    ].join(" ")
                  }
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-sm">{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <main className="overflow-auto bg-neutral-50">
        <div className="max-w-6xl mx-auto p-4">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
