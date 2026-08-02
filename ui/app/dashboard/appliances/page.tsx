"use client"
import React from 'react';
import { HardDrive } from 'lucide-react';

/**
 * Redirecionamento: a gestão de appliances agora é feita via
 * "Frota & Deploys" (/dashboard/deploys) que usa a API unificada
 * /api/provisioning.
 */
export default function AppliancesRedirect() {
  if (typeof window !== 'undefined') {
    window.location.href = '/dashboard/deploys';
  }
  
  return (
    <div className="p-8 text-center text-slate-400 space-y-4">
      <HardDrive size={48} className="mx-auto opacity-30" />
      <p>Redirecionando para Frota & Deploys...</p>
    </div>
  );
}
