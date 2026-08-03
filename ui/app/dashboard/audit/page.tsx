"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import {
  ScrollText, Loader2, Filter, Building2, Trash2, Pencil,
  Plus, UserPlus, UserMinus, KeyRound, PauseCircle, ShieldAlert,
} from 'lucide-react';

/**
 * Trilha de auditoria.
 *
 * A trilha era gravada desde a fundação multi-tenant, mas não havia como lê-la
 * — governança que só escreve é arquivo morto. Um cliente empresarial pergunta
 * "quem apagou esta loja?" e a resposta precisa estar aqui, não num SELECT
 * manual no Supabase.
 *
 * Somente leitura, e sem botão de apagar: uma trilha que a aplicação consegue
 * alterar não serve como trilha.
 */

const fetcher = (url: string) => {
  const token = localStorage.getItem('admin_token');
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
};

interface Registro {
  id: number;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  actor_email: string | null;
  detail: any;
  ip_address: string | null;
  created_at: string;
  organization_name: string | null;
}

/** Ícone e cor por ação. Destrutivo em vermelho — é o que se procura primeiro. */
const APARENCIA: Record<string, { Icone: any; cor: string }> = {
  'store.create':          { Icone: Plus,        cor: 'text-emerald-400' },
  'store.update':          { Icone: Pencil,      cor: 'text-sky-400' },
  'store.delete':          { Icone: Trash2,      cor: 'text-red-400' },
  'user.create':           { Icone: UserPlus,    cor: 'text-emerald-400' },
  'user.invite':           { Icone: UserPlus,    cor: 'text-sky-400' },
  'membership.revoke':     { Icone: UserMinus,   cor: 'text-red-400' },
  'organization.create':   { Icone: Building2,   cor: 'text-emerald-400' },
  'organization.update':   { Icone: Pencil,      cor: 'text-sky-400' },
  'organization.suspensa': { Icone: PauseCircle, cor: 'text-amber-400' },
  'organization.cancelada':{ Icone: PauseCircle, cor: 'text-red-400' },
  'provisioning.issue':    { Icone: KeyRound,    cor: 'text-violet-400' },
};

const FILTROS = [
  { id: '', rotulo: 'Tudo' },
  { id: 'store.delete', rotulo: 'Exclusões de loja' },
  { id: 'membership.revoke', rotulo: 'Acessos revogados' },
  { id: 'provisioning.issue', rotulo: 'Códigos emitidos' },
  { id: 'organization.suspensa', rotulo: 'Suspensões' },
];

function quandoRelativo(iso: string): string {
  const segundos = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (segundos < 60) return 'agora há pouco';
  if (segundos < 3600) return `há ${Math.floor(segundos / 60)} min`;
  if (segundos < 86400) return `há ${Math.floor(segundos / 3600)} h`;
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function AuditPage() {
  const [filtro, setFiltro] = useState('');
  const url = `/api/audit?limit=100${filtro ? `&action=${encodeURIComponent(filtro)}` : ''}`;
  const { data, error, isLoading } = useSWR<{ registros: Registro[] } | { error: string }>(url, fetcher);

  const registros = data && 'registros' in data ? data.registros : [];
  const erroApi = data && 'error' in data ? data.error : null;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-100 flex items-center gap-2">
          <ScrollText size={24} className="text-sky-400" />
          Auditoria
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Quem fez o quê, quando e de onde. Registro imutável — não há como editar ou apagar.
        </p>
      </div>

      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <Filter size={14} className="text-slate-500" />
        {FILTROS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFiltro(f.id)}
            className={`px-3 py-1 rounded-full text-xs transition ${
              filtro === f.id
                ? 'bg-sky-600 text-white'
                : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            {f.rotulo}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8">
          <Loader2 size={16} className="animate-spin" /> Carregando…
        </div>
      )}

      {(error || erroApi) && (
        <div className="flex items-start gap-2 p-4 bg-red-950/50 border border-red-900 rounded-lg text-sm text-red-300">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <span>{erroApi || 'Falha ao carregar a auditoria.'}</span>
        </div>
      )}

      {!isLoading && !error && registros.length === 0 && (
        <div className="text-center py-16 text-slate-500">
          <ScrollText size={40} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">
            {filtro ? 'Nenhum registro para este filtro.' : 'Nenhuma ação registrada ainda.'}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        {registros.map((r) => {
          const { Icone, cor } = APARENCIA[r.action] || { Icone: ScrollText, cor: 'text-slate-400' };
          return (
            <div
              key={r.id}
              className="flex items-start gap-3 p-3 bg-slate-900 border border-slate-800 rounded-lg hover:border-slate-700 transition"
            >
              <Icone size={16} className={`${cor} mt-0.5 shrink-0`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-xs text-slate-300">{r.action}</span>
                  {r.resource_type && (
                    <span className="text-xs text-slate-500">
                      {r.resource_type} #{r.resource_id}
                    </span>
                  )}
                  {r.organization_name && (
                    <span className="text-xs text-slate-500">· {r.organization_name}</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {/* actor_email é guardado como texto: a pergunta "quem fez
                      isso?" continua tendo resposta depois que a pessoa sai. */}
                  <span className="text-slate-400">{r.actor_email || 'sistema'}</span>
                  {r.ip_address && <span className="ml-2 font-mono">{r.ip_address}</span>}
                </div>
                {r.detail && (
                  <pre className="mt-1.5 text-[11px] text-slate-500 bg-slate-950 rounded px-2 py-1 overflow-x-auto">
                    {typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}
                  </pre>
                )}
              </div>
              <span
                className="text-[11px] text-slate-500 shrink-0 whitespace-nowrap"
                title={new Date(r.created_at).toLocaleString('pt-BR')}
              >
                {quandoRelativo(r.created_at)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
