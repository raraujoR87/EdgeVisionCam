"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import {
  Building2, Plus, Loader2, Store as StoreIcon, HardDrive, Users,
  Activity, AlertTriangle, PauseCircle, PlayCircle, ShieldAlert,
} from 'lucide-react';
import { PLANOS as PLANOS_API } from '../../api/planos';

/**
 * Clientes (organizações) — a tela que faltava.
 *
 * Sem ela não havia como cadastrar um cliente: o painel era loja-cêntrico, e
 * onboarding de uma rede virava N lojas soltas sem visão de conjunto.
 *
 * O que ela mostra além do óbvio: consumo contra o limite do plano e sinal de
 * inatividade. Um cliente que atingiu o teto não consegue crescer e ninguém
 * percebe; um cliente sem eventos há 24h está pagando por algo que parou.
 * Os dois são conversas comerciais que precisam acontecer antes do churn.
 */

const fetcher = (url: string) => {
  const token = localStorage.getItem('admin_token');
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
};

// Mesma tabela que a API valida. Duplicar aqui faria a tela oferecer um plano
// que a rota recusa — divergência que só aparece no clique do usuário.
const PLANOS = Object.entries(PLANOS_API).map(([id, p]) => ({
  id,
  rotulo: p.rotulo,
  lojas: p.max_stores,
  appliances: p.max_appliances,
}));

const CORES_PLANO: Record<string, string> = {
  trial: 'bg-slate-700 text-slate-300',
  legado: 'bg-amber-900/50 text-amber-300',
  essencial: 'bg-sky-900/50 text-sky-300',
  profissional: 'bg-violet-900/50 text-violet-300',
  enterprise: 'bg-emerald-900/50 text-emerald-300',
};

interface Org {
  id: number;
  name: string;
  slug: string;
  plan: string;
  status: string;
  max_stores: number;
  max_appliances: number;
  store_count: number;
  appliance_count: number;
  member_count: number;
  eventos_24h: number;
}

/** Barra de consumo. Fica âmbar antes de estourar, não depois. */
function Consumo({ atual, limite, rotulo, Icone }: {
  atual: number; limite: number; rotulo: string; Icone: any;
}) {
  const proporcao = limite > 0 ? Math.min(atual / limite, 1) : 0;
  const noLimite = atual >= limite;
  const perto = !noLimite && proporcao >= 0.8;

  return (
    <div className="flex-1 min-w-[120px]">
      <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
        <Icone size={13} />
        <span>{rotulo}</span>
        <span className={`ml-auto font-mono ${noLimite ? 'text-red-400' : perto ? 'text-amber-400' : 'text-slate-300'}`}>
          {atual}/{limite}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            noLimite ? 'bg-red-500' : perto ? 'bg-amber-500' : 'bg-sky-500'
          }`}
          style={{ width: `${proporcao * 100}%` }}
        />
      </div>
    </div>
  );
}

export default function OrganizationsPage() {
  const { data, error, mutate, isLoading } = useSWR<Org[] | { error: string }>('/api/organizations', fetcher);

  const [criando, setCriando] = useState(false);
  const [form, setForm] = useState({ name: '', plan: 'trial' });
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const token = () => localStorage.getItem('admin_token') || '';

  const criar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify(form),
      });
      const corpo = await res.json();
      if (res.ok) {
        setCriando(false);
        setForm({ name: '', plan: 'trial' });
        mutate();
      } else {
        setAviso(corpo.error || 'Não foi possível cadastrar.');
      }
    } catch {
      setAviso('Falha de rede.');
    }
    setSalvando(false);
  };

  const alterar = async (id: number, mudanca: { plan?: string; status?: string }) => {
    setAviso(null);
    const res = await fetch('/api/organizations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, ...mudanca }),
    });
    if (!res.ok) {
      const corpo = await res.json();
      setAviso(corpo.error || 'Não foi possível alterar.');
      return;
    }
    mutate();
  };

  const orgs = Array.isArray(data) ? data : [];
  const erroApi = !Array.isArray(data) && data?.error;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100 flex items-center gap-2">
            <Building2 size={24} className="text-sky-400" />
            Clientes
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Cada cliente é uma organização, com suas lojas, sua equipe e seu plano.
          </p>
        </div>
        <button
          onClick={() => setCriando(!criando)}
          className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
        >
          <Plus size={16} /> Novo cliente
        </button>
      </div>

      {aviso && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-red-950/50 border border-red-900 rounded-lg text-sm text-red-300">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <span>{aviso}</span>
        </div>
      )}

      {criando && (
        <form onSubmit={criar} className="mb-6 p-4 bg-slate-900 border border-slate-800 rounded-xl">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Nome do cliente</label>
              <input
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Rede Exemplo Ltda"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-slate-100 text-sm focus:border-sky-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Plano</label>
              <select
                value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value })}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-slate-100 text-sm focus:border-sky-500 outline-none"
              >
                {PLANOS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.rotulo} — {p.lojas} loja(s), {p.appliances} appliance(s)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              type="submit"
              disabled={salvando || !form.name.trim()}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium flex items-center gap-2"
            >
              {salvando && <Loader2 size={14} className="animate-spin" />}
              Cadastrar
            </button>
            <button
              type="button"
              onClick={() => setCriando(false)}
              className="px-4 py-2 text-slate-400 hover:text-slate-200 text-sm"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-8">
          <Loader2 size={16} className="animate-spin" /> Carregando…
        </div>
      )}

      {(error || erroApi) && (
        <div className="p-4 bg-red-950/50 border border-red-900 rounded-lg text-sm text-red-300">
          {erroApi || 'Falha ao carregar os clientes.'}
        </div>
      )}

      {!isLoading && !error && orgs.length === 0 && (
        <div className="text-center py-16 text-slate-500">
          <Building2 size={40} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Nenhum cliente cadastrado ainda.</p>
        </div>
      )}

      <div className="space-y-3">
        {orgs.map((org) => {
          const suspensa = org.status !== 'ativa';
          // Sem evento nas últimas 24h com appliance instalado é o sinal de que
          // o cliente está pagando por algo que parou de funcionar.
          const parado = org.appliance_count > 0 && org.eventos_24h === 0;

          return (
            <div
              key={org.id}
              className={`p-4 rounded-xl border transition ${
                suspensa
                  ? 'bg-slate-900/40 border-slate-800 opacity-60'
                  : 'bg-slate-900 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-medium text-slate-100 truncate">{org.name}</h2>
                    <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${CORES_PLANO[org.plan] || CORES_PLANO.trial}`}>
                      {org.plan}
                    </span>
                    {suspensa && (
                      <span className="px-2 py-0.5 rounded text-[11px] bg-red-900/50 text-red-300">
                        {org.status}
                      </span>
                    )}
                    {parado && !suspensa && (
                      <span
                        title="Appliance instalado, mas nenhum evento nas últimas 24h"
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-amber-900/50 text-amber-300"
                      >
                        <AlertTriangle size={11} /> sem detecção 24h
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">{org.slug}</p>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={org.plan}
                    onChange={(e) => alterar(org.id, { plan: e.target.value })}
                    className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-xs text-slate-300 outline-none focus:border-sky-500"
                  >
                    {PLANOS.map((p) => (
                      <option key={p.id} value={p.id}>{p.rotulo}</option>
                    ))}
                    {!PLANOS.some((p) => p.id === org.plan) && (
                      <option value={org.plan}>{org.plan}</option>
                    )}
                  </select>
                  <button
                    onClick={() => alterar(org.id, { status: suspensa ? 'ativa' : 'suspensa' })}
                    title={suspensa ? 'Reativar' : 'Suspender — não apaga dado nenhum'}
                    className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition"
                  >
                    {suspensa ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-4">
                <Consumo atual={org.store_count} limite={org.max_stores} rotulo="Lojas" Icone={StoreIcon} />
                <Consumo atual={org.appliance_count} limite={org.max_appliances} rotulo="Appliances" Icone={HardDrive} />
                <div className="flex-1 min-w-[120px]">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
                    <Users size={13} /> <span>Equipe</span>
                    <span className="ml-auto font-mono text-slate-300">{org.member_count}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <Activity size={13} /> <span>Eventos 24h</span>
                    <span className={`ml-auto font-mono ${parado ? 'text-amber-400' : 'text-slate-300'}`}>
                      {org.eventos_24h}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
