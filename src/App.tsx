import { useEffect, useState } from 'react';

type SystemInfo = {
  platform: string;
  release: string;
  arch: string;
  memoryGB: number;
  hostname: string;
};

declare global {
  interface Window {
    api: {
      getSystemInfo: () => Promise<SystemInfo>;
    };
  }
}

export default function App() {
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    window.api.getSystemInfo().then(setInfo).catch(console.error);
  }, []);

  console.log(info);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-6">
      <h1 className="text-3xl font-bold mb-4">CoffeeCare — Diagnostic PC</h1>

      {!info ? (
        <p>Chargement des infos système...</p>
      ) : (
        <ul className="list-disc ml-5 space-y-1">
          <li><strong>Machine :</strong> {info.hostname}</li>
          <li><strong>OS :</strong> {info.platform} {info.release}</li>
          <li><strong>Architecture :</strong> {info.arch}</li>
          <li><strong>Mémoire :</strong> {info.memoryGB} Go</li>
        </ul>
      )}
    </div>
  );
}
