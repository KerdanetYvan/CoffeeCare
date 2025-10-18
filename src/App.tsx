import React, { Suspense, lazy } from "react";
import { Route, Routes, Navigate } from "react-router-dom";
import MainLayout from "./components/layout/MainLayout";

// Code splitting par page (optionnel mais conseillé)
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Cleaning  = lazy(() => import("./pages/Cleaning"));
const Repair    = lazy(() => import("./pages/Repair"));
const Updates   = lazy(() => import("./pages/Updates"));
const Settings  = lazy(() => import("./pages/Settings"));
const NotFound  = lazy(() => import("./pages/NotFound"));

export default function App() {
  return (
    // Suspense affiche un fallback le temps de charger les pages en lazy
    <Suspense fallback={<div className="p-6">Chargement…</div>}>
      <Routes>
        {/* Toutes les pages partagent le même layout */}
        <Route element={<MainLayout />}>
          {/* Index = / => Dashboard */}
          <Route index element={<Dashboard />} />
          {/* Routes principales CoffeeCare */}
          <Route path="cleaning" element={<Cleaning />} />
          <Route path="repair"   element={<Repair />} />
          <Route path="updates"  element={<Updates />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        {/* Redirection “/home” -> “/” (facultatif) */}
        <Route path="home" element={<Navigate to="/" replace />} />

        {/* 404 */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
