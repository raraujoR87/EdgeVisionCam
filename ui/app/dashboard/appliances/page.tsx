"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { HardDrive, Plus, Loader2, Key, Terminal, Copy, CheckCircle2, Store } from 'lucide-react';

const fetcher = (url: string) => fetch(url).then(res => res.json());

export default function AppliancesManagementPage() {
  const { data: appliances, error, mutate } = useSWR('/api/appliances', fetcher);
  const { data: stores } = useSWR('/api/stores', fetcher);
  
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({ store_id: '', label: '', target_version: 'latest' });
  const [isSaving, setIsSaving] = useState(false);
  const [newAppliance, setNewAppliance] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const res = await fetch('/api/appliances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        const data = await res.json();
        setNewAppliance(data);
        setIsCreating(false);
        setFormData({ store_id: '', label: '', target_version: 'latest' });
        mutate();
      }
    } catch (err) {
      console.error(err);
    }
    setIsSaving(false);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (error) return <div className="text-rose-500 p-8">Erro ao carregar appliances.</div>;
  if (!appliances || !stores) return <div className="p-8 flex items-center gap-2 text-slate-400"><Loader2 className="animate-spin" /> Carregando dispositivos...</div>;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
            Frota de Dispositivos (Edge)
          </h1>
          <p className="text-slate-400 text-sm mt-1">Gerencie e provisione novas unidades de hardware (Radxa) nas lojas</p>
        </div>
        <button 
          onClick={() => { setIsCreating(!isCreating); setNewAppliance(null); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-colors"
        >
          <Plus size={18} /> Novo Dispositivo
        </button>
      </div>

      {newAppliance && (
        <div className="bg-emerald-950/40 border border-emerald-500/50 p-6 rounded-2xl backdrop-blur-md">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="text-emerald-400" size={24} />
            <h2 className="text-xl font-bold text-emerald-400">Dispositivo Cadastrado com Sucesso!</h2>
          </div>
          <p className="text-slate-300 mb-6">Para conectar a câmera/placa física (Radxa) à nuvem, acesse o terminal do equipamento e cole o comando abaixo. Ele fará o provisionamento injetando a chave única.</p>
          
          <div className="bg-slate-950 rounded-lg p-4 font-mono text-sm border border-slate-800 relative group flex items-start justify-between">
            <div className="text-emerald-300 break-all pr-8">
              sudo /opt/visioncam/edge_provisioning.py --edge_key {newAppliance.edge_key} --store_id {newAppliance.store_id}
            </div>
            <button 
              onClick={() => copyToClipboard(`sudo /opt/visioncam/edge_provisioning.py --edge_key ${newAppliance.edge_key} --store_id ${newAppliance.store_id}`)}
              className="absolute top-4 right-4 p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md transition-colors"
              title="Copiar comando"
            >
              {copied ? <CheckCircle2 size={16} className="text-emerald-400"/> : <Copy size={16} />}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400 bg-slate-900/50 p-3 rounded-lg">
            <Key size={14} className="text-blue-400"/>
            <span><strong>Edge Key:</strong> <span className="font-mono text-slate-300">{newAppliance.edge_key}</span></span>
          </div>
        </div>
      )}

      {isCreating && (
        <div className="bg-slate-900/60 border border-slate-800 p-6 rounded-2xl backdrop-blur-md">
          <h2 className="text-xl font-bold mb-4 text-white">Cadastrar Novo Dispositivo (Appliance)</h2>
          <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Loja de Destino *</label>
                <select 
                  required 
                  value={formData.store_id} 
                  onChange={e => setFormData({...formData, store_id: e.target.value})} 
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">-- Selecione uma loja --</option>
                  {stores.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.location})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Rótulo / Nome *</label>
                <input required type="text" value={formData.label} onChange={e => setFormData({...formData, label: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500" placeholder="Ex: Câmera Corredor 1" />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-slate-800 mt-2">
              <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-2 text-slate-400 hover:text-white font-semibold">Cancelar</button>
              <button type="submit" disabled={isSaving || !formData.store_id || !formData.label} className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-bold transition-colors">
                {isSaving ? <Loader2 size={18} className="animate-spin" /> : <HardDrive size={18} />} Gerar Credenciais
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {appliances.map((app: any) => {
          const store = stores.find((s: any) => s.id === app.store_id);
          return (
            <div key={app.id} className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md hover:border-slate-600 transition-colors">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-xl font-bold text-white flex items-center gap-2"><HardDrive size={20} className="text-blue-400" /> {app.label || 'Sem Rótulo'}</h3>
                  <div className="text-slate-400 text-sm flex items-center gap-1.5 mt-1">
                    <Store size={14} /> {store?.name || 'Loja Desconhecida'}
                  </div>
                </div>
                <span className={`text-xs font-bold px-2 py-1 rounded ${app.status === 'ATIVO' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-800 text-slate-300'}`}>
                  {app.status || 'PENDENTE'}
                </span>
              </div>
              
              <div className="space-y-3 mt-6 border-t border-slate-800/80 pt-4">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500 flex items-center gap-1.5"><Key size={14}/> Edge Key</span>
                  <span className="font-mono text-slate-300 bg-slate-950 px-2 py-0.5 rounded truncate max-w-[150px]" title={app.edge_key}>
                    {app.edge_key ? '••••' + app.edge_key.slice(-6) : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500 flex items-center gap-1.5"><Terminal size={14}/> PIN Provisionamento</span>
                  <span className="font-mono font-bold text-amber-400 bg-amber-950/30 px-2 py-0.5 rounded">
                    {app.provisioning_code || 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
