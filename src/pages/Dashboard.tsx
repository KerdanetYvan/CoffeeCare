import React from "react";

export default function Dashboard() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-neutral-600">
        Vue d’ensemble : OS, CPU, GPU (températures), RAM, stockage, etc.
      </p>
      {/* TODO: cartes de résumé + CTA “Analyser maintenant” */}
    </section>
  );
}
