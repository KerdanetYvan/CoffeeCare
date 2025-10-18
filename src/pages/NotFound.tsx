import React from "react";
import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="h-[60vh] grid place-items-center">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">404</h1>
        <p className="text-neutral-600">Page introuvable</p>
        <Link to="/" className="text-sm underline">Retour au Dashboard</Link>
      </div>
    </div>
  );
}
