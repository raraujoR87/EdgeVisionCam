import React from 'react';
import { query, isDatabaseNotConfigured } from '../api/db';
import { classificarLoja, APARENCIA, lojasComProblema } from './fleet';
import { Shield, Activity, Monitor, AlertOctagon, Terminal, ExternalLink, HelpCircle } from 'lucide-react';

// Forçar Next.js a rodar de forma dinâmica (sem build cache estático)
export const dynamic = 'force-dynamic';

interface StoreData {
  id: number;
  name: string;
  location: string;
  portainer_endpoint: string | null;
  cpu_usage: number | null;
  ram_usage: number | null;
  npu_status: string | null;
  inference_ms: number | null;
  last_seen: string | null;
  total_events: number;
  critical_events: number;
}

export default async function DashboardPage() {
  let stores: StoreData[] = [];
  let isOffline = false;
  // Distingue "nenhuma loja cadastrada" de "banco inacessível". Tratar os dois
  // como o mesmo estado esconde justamente o problema que precisa de ação.
  let erroDeConfiguracao = false;

  try {
    const res = await query(`
      SELECT s.id, s.name, s.location, s.portainer_endpoint,
             h.cpu_usage, h.ram_usage, h.npu_status, h.inference_ms, h.last_seen,
             COALESCE((SELECT COUNT(*) FROM events e WHERE e.store_id = s.id), 0)::integer as total_events,
             COALESCE((SELECT COUNT(*) FROM events e WHERE e.store_id = s.id AND e.verdict IN ('FURTO_CONFIRMADO', 'SUSPEITO')), 0)::integer as critical_events
      FROM stores s
      LEFT JOIN hardware_status h ON h.store_id = s.id
      ORDER BY s.id ASC
    `);
    
    stores = res.rows as StoreData[];
    
    if (stores.length === 0) {
      isOffline = true;
    }
  } catch (err) {
    console.error('Falha ao consultar banco central', err);
    isOffline = true;
    erroDeConfiguracao = isDatabaseNotConfigured(err);
  }

  // Métricas agregadas
  const totalStores = stores.length;
  // "Online" agora exige estar detectando. Contar container de pé como online
  // era o que fazia uma loja cega parecer saudável no painel.
  const detectando = stores.filter(s => classificarLoja(s) === 'DETECTANDO').length;
  const comProblema = lojasComProblema(stores);
  const totalEventsCount = stores.reduce((acc, s) => acc + s.total_events, 0);
  const totalCriticalAlerts = stores.reduce((acc, s) => acc + s.critical_events, 0);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
            Painel Centralizador Multilojas
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Monitoramento de hardware, alertas e gestão de agentes de borda (Next.js + Vercel)
          </p>
        </div>
        {erroDeConfiguracao ? (
          <span className="px-3 py-1 bg-rose-950/40 text-rose-400 border border-rose-800/40 rounded-full text-xs font-bold font-mono">
            ⚠️ DATABASE_URL AUSENTE — CONFIGURE E REFAÇA O DEPLOY
          </span>
        ) : isOffline && (
          <span className="px-3 py-1 bg-amber-950/40 text-amber-400 border border-amber-800/40 rounded-full text-xs font-bold font-mono">
            ⚠️ MODO DEMONSTRAÇÃO (BANCO DE CONEXÃO LOCAL)
          </span>
        )}
      </div>

      {/* Grid de Métricas Gerais */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <Monitor className="text-blue-500" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Lojas Cadastradas</span>
          </div>
          <div className="text-4xl font-extrabold">{totalStores}</div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <Activity className="text-emerald-500" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Detectando</span>
          </div>
          <div className={`text-4xl font-extrabold ${comProblema.length ? 'text-amber-400' : 'text-emerald-500'}`}>
            {detectando} <span className="text-lg text-slate-600 font-normal">/ {totalStores}</span>
          </div>
          {comProblema.length > 0 && (
            <div className="text-[10px] font-bold text-amber-400/80 uppercase tracking-wider mt-2">
              {comProblema.length} loja(s) exigindo atenção
            </div>
          )}
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <Shield className="text-indigo-400" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Eventos de Auditoria</span>
          </div>
          <div className="text-4xl font-extrabold text-indigo-400">{totalEventsCount}</div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <AlertOctagon className="text-rose-500" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Alertas Críticos (IA)</span>
          </div>
          <div className="text-4xl font-extrabold text-rose-500">{totalCriticalAlerts}</div>
        </div>
      </div>

      {/* Lista de Dispositivos e Lojas */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl backdrop-blur-md overflow-hidden">
        <div className="p-6 border-b border-slate-800/80 flex justify-between items-center">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Terminal size={18} className="text-blue-500" /> Status das Lojas & Agentes de Borda
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800/80 text-xs font-bold text-slate-500 uppercase">
                <th className="p-6">Loja / Localização</th>
                <th className="p-6">Conexão Radxa</th>
                <th className="p-6">Métricas CPU / RAM</th>
                <th className="p-6">Status NPU</th>
                <th className="p-6">Alertas Críticos</th>
                <th className="p-6 text-right">Gerência Remota</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40 text-sm">
              {stores.map(store => {
                const isOnline = classificarLoja(store) !== 'OFFLINE' && classificarLoja(store) !== 'NUNCA_CONECTOU';
                
                return (
                  <tr key={store.id} className="hover:bg-slate-800/20 transition-colors">
                    <td className="p-6">
                      <div className="font-bold text-white">{store.name}</div>
                      <div className="text-xs text-slate-500">{store.location}</div>
                    </td>
                    <td className="p-6">
                      {(() => {
                        const saude = classificarLoja(store);
                        const vis = APARENCIA[saude];
                        return (
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${vis.ponto}`}></span>
                            <span className={vis.classe}>{vis.rotulo}</span>
                            {store.last_seen && (
                              <span className="text-xs text-slate-600">
                                ({new Date(store.last_seen).toLocaleTimeString('pt-BR')})
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="p-6 font-mono text-xs">
                      {isOnline && store.cpu_usage !== null && store.ram_usage !== null ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="w-8 text-slate-500">CPU:</span>
                            <div className="w-20 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                              <div className="bg-blue-500 h-full" style={{ width: `${Math.min(100, store.cpu_usage)}%` }}></div>
                            </div>
                            <span className="text-blue-400">{store.cpu_usage.toFixed(1)}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="w-8 text-slate-500">RAM:</span>
                            <div className="w-20 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                              <div className="bg-purple-500 h-full" style={{ width: `${Math.min(100, store.ram_usage)}%` }}></div>
                            </div>
                            <span className="text-purple-400">{store.ram_usage.toFixed(1)}%</span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-600">--</span>
                      )}
                    </td>
                    <td className="p-6">
                      {isOnline && store.npu_status ? (
                        <span className={`px-2 py-1 rounded text-xs font-bold font-mono ${
                          store.npu_status === 'ACTIVE_TIMVX' 
                            ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40' 
                            : 'bg-amber-950/40 text-amber-400 border border-amber-800/40'
                        }`}>
                          {store.npu_status === 'ACTIVE_TIMVX' ? 'NPU Vivante VIP9000' : 'Fallback CPU'}
                        </span>
                      ) : (
                        <span className="text-slate-600">--</span>
                      )}
                    </td>
                    <td className="p-6">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white">{store.critical_events}</span>
                        {store.critical_events > 0 && (
                          <span className="px-1.5 py-0.5 bg-rose-950/30 text-rose-400 border border-rose-800/30 rounded text-[10px] font-bold">
                            ALERTA
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-6 text-right">
                      {store.portainer_endpoint ? (
                        <a 
                          href={store.portainer_endpoint}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-blue-600 text-slate-200 hover:text-white rounded-lg text-xs font-semibold transition-colors"
                        >
                          Portainer Edge <ExternalLink size={12} />
                        </a>
                      ) : (
                        <span className="text-xs text-slate-600 italic">Sem agente configurado</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
