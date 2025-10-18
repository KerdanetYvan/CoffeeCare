import React from "react";

export default function Settings() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Paramètres</h1>
      <ul className="list-disc list-inside text-neutral-700">
        <li>Thème (clair/sombre)</li>
        <li>Langue</li>
        <li>Télémetrie / logs</li>
        <li>Chemins (exports, backups…)</li>
      </ul>
    </section>
  );
}
