import React from 'react';
import { query, isDatabaseNotConfigured } from '../api/db';
import { classificarLoja, APARENCIA, lojasComProblema } from './fleet';
import { Shield, Activity, Monitor, AlertOctagon, Terminal, ExternalLink, HelpCircle, HardDrive } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface StoreData {
  store_id: number;
  store_name: string;
  location: string;
  portainer_endpoint: string | null;
  appliance_id: number | null;
  label: string | null;
  cpu_usage: number | null;
  ram_usage: number | null;
  npu_status: string | null;
  inference_ms: number | null;
  last_seen: string | null;
  total_events: number;
  critical_events: number;
}

export default async function DashboardPage() {
  let items: StoreData[] = [];
  let isOffline = false;
  let erroDeConfiguracao = false;

  try {
    const res = await query(`
      SELECT s.id as store_id, s.name as store_name, s.location, s.portainer_endpoint,
             a.id as appliance_id, a.label,
             h.cpu_usage, h.ram_usage, h.npu_status, h.inference_ms, h.last_seen,
             COALESCE((SELECT COUNT(*) FROM events e WHERE e.store_id = s.id AND (a.id IS NULL OR e.appliance_id = a.id)), 0)::integer as total_events,
             COALESCE((SELECT COUNT(*) FROM events e WHERE e.store_id = s.id AND (a.id IS NULL OR e.appliance_id = a.id) AND e.verdict IN ('FURTO_CONFIRMADO', 'SUSPEITO')), 0)::integer as critical_events
      FROM stores s
      LEFT JOIN appliances a ON a.store_id = s.id
      LEFT JOIN hardware_status h ON h.appliance_id = a.id
      ORDER BY s.id ASC, a.id ASC
    `);
    
    items = res.rows as StoreData[];
    if (items.length === 0) isOffline = true;
  } catch (err) {
    console.error('Falha ao consultar banco central', err);
    isOffline = true;
    erroDeConfiguracao = isDatabaseNotConfigured(err);
  }

  const totalStores = new Set(items.map(i => i.store_id)).size;
  const totalAppliances = items.filter(i => i.appliance_id !== null).length;
  const detectando = items.filter(i => i.appliance_id && classificarLoja({ last_seen: i.last_seen, inference_ms: i.inference_ms }) === 'DETECTANDO').length;
  const totalEventsCount = items.reduce((acc, s) => acc + s.total_events, 0);
  const totalCriticalAlerts = items.reduce((acc, s) => acc + s.critical_events, 0);

  const grouped = items.reduce((acc, item) => {
    if (!acc[item.store_id]) {
      acc[item.store_id] = { store: item, appliances: [] };
    }
    if (item.appliance_id) {
      acc[item.store_id].appliances.push(item);
    }
    return acc;
  }, {} as Record<number, { store: StoreData, appliances: StoreData[] }>);

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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <Monitor className="text-blue-500" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Lojas / Appliances</span>
          </div>
          <div className="text-4xl font-extrabold">{totalStores} <span className="text-lg text-slate-600 font-normal">/ {totalAppliances}</span></div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <Activity className="text-emerald-500" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Appliances Detectando</span>
          </div>
          <div className="text-4xl font-extrabold text-emerald-500">
            {detectando} <span className="text-lg text-slate-600 font-normal">/ {totalAppliances}</span>
          </div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <Shield className="text-indigo-400" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Eventos Totais</span>
          </div>
          <div className="text-4xl font-extrabold text-indigo-400">{totalEventsCount}</div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex justify-between items-center mb-4">
            <AlertOctagon className="text-rose-500" size={20} />
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Alertas Críticos</span>
          </div>
          <div className="text-4xl font-extrabold text-rose-500">{totalCriticalAlerts}</div>
        </div>
      </div>

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
                <th className="p-6">Appliance / Dispositivo</th>
                <th className="p-6">Conexão Radxa</th>
                <th className="p-6">Métricas CPU / RAM</th>
                <th className="p-6">Status NPU</th>
                <th className="p-6 text-right">Gerência Remota</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40 text-sm">
              {Object.values(grouped).map(({store, appliances}) => {
                const rows = appliances.length > 0 ? appliances : [store];
                
                return rows.map((app, idx) => {
                  const estado = { last_seen: app.last_seen, inference_ms: app.inference_ms };
                  const isOnline = app.appliance_id && classificarLoja(estado) !== 'OFFLINE' && classificarLoja(estado) !== 'NUNCA_CONECTOU';
                  
                  return (
                    <tr key={`${store.store_id}-${app.appliance_id || 'none'}`} className="hover:bg-slate-800/20 transition-colors">
                      {idx === 0 ? (
                        <td className="p-6 border-r border-slate-800/20 align-top bg-slate-900/40" rowSpan={appliances.length || 1}>
                          <div className="font-bold text-white text-base">{store.store_name}</div>
                          <div className="text-xs text-slate-400 mt-1">{store.location}</div>
                        </td>
                      ) : null}
                      <td className="p-6">
                        {app.appliance_id ? (
                          <div className="flex items-center gap-2">
                            <HardDrive size={14} className="text-slate-400" />
                            <span className="font-medium text-slate-200">{app.label}</span>
                          </div>
                        ) : (
                          <span className="text-slate-500 italic">Nenhum appliance</span>
                        )}
                      </td>
                      <td className="p-6">
                        {app.appliance_id ? (() => {
                          const saude = classificarLoja(estado);
                          const vis = APARENCIA[saude];
                          return (
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full ${vis.ponto}`}></span>
                              <span className={vis.classe}>{vis.rotulo}</span>
                              {app.last_seen && (
                                <span className="text-xs text-slate-600">
                                  ({new Date(app.last_seen).toLocaleTimeString('pt-BR')})
                                </span>
                              )}
                            </div>
                          );
                        })() : '--'}
                      </td>
                      <td className="p-6 font-mono text-xs">
                        {isOnline && app.cpu_usage !== null && app.ram_usage !== null ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="w-8 text-slate-500">CPU:</span>
                              <div className="w-20 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div className="bg-blue-500 h-full" style={{ width: `${Math.min(100, app.cpu_usage)}%` }}></div>
                              </div>
                              <span className="text-blue-400">{app.cpu_usage.toFixed(1)}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-8 text-slate-500">RAM:</span>
                              <div className="w-20 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div className="bg-purple-500 h-full" style={{ width: `${Math.min(100, app.ram_usage)}%` }}></div>
                              </div>
                              <span className="text-purple-400">{app.ram_usage.toFixed(1)}%</span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-600">--</span>
                        )}
                      </td>
                      <td className="p-6">
                        {isOnline && app.npu_status ? (
                          <span className={`px-2 py-1 rounded text-xs font-bold font-mono ${
                            app.npu_status === 'ACTIVE_TIMVX' 
                              ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40' 
                              : 'bg-amber-950/40 text-amber-400 border border-amber-800/40'
                          }`}>
                            {app.npu_status === 'ACTIVE_TIMVX' ? 'NPU VIP9000' : 'Fallback CPU'}
                          </span>
                        ) : (
                          <span className="text-slate-600">--</span>
                        )}
                      </td>
                      <td className="p-6 text-right">
                        {idx === 0 && store.portainer_endpoint ? (
                          <a 
                            href={store.portainer_endpoint}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-blue-600 text-slate-200 hover:text-white rounded-lg text-xs font-semibold transition-colors"
                          >
                            Portainer <ExternalLink size={12} />
                          </a>
                        ) : (
                          idx === 0 ? <span className="text-xs text-slate-600 italic">Sem gerência</span> : null
                        )}
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
