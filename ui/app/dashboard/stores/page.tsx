"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { Store, Plus, MapPin, Key, MessageSquare, Loader2, RefreshCw } from 'lucide-react';

const fetcher = (url: string) => fetch(url).then(res => res.json());

export default function StoresManagementPage() {
  const { data: stores, error, mutate } = useSWR('/api/stores', fetcher);
  
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({ name: '', location: '', telegram_bot_token: '', telegram_chat_id: '' });
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const res = await fetch('/api/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        setIsCreating(false);
        setFormData({ name: '', location: '', telegram_bot_token: '', telegram_chat_id: '' });
        mutate();
      }
    } catch (err) {
      console.error(err);
    }
    setIsSaving(false);
  };

  if (error) return <div className="text-rose-500 p-8">Erro ao carregar lojas.</div>;
  if (!stores) return <div className="p-8 flex items-center gap-2 text-slate-400"><Loader2 className="animate-spin" /> Carregando lojas...</div>;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
            Lojas e Clientes
          </h1>
          <p className="text-slate-400 text-sm mt-1">Gerencie os estabelecimentos cadastrados no sistema central</p>
        </div>
        <button 
          onClick={() => setIsCreating(!isCreating)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-colors"
        >
          <Plus size={18} /> Nova Loja
        </button>
      </div>

      {isCreating && (
        <div className="bg-slate-900/60 border border-slate-800 p-6 rounded-2xl backdrop-blur-md">
          <h2 className="text-xl font-bold mb-4 text-white">Cadastrar Nova Loja</h2>
          <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Nome da Loja *</label>
                <input required type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500" placeholder="Ex: Supermercado Central" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Localização / Cidade</label>
                <input type="text" value={formData.location} onChange={e => setFormData({...formData, location: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500" placeholder="Ex: São Paulo, SP" />
              </div>
              <div className="col-span-2 grid grid-cols-2 gap-4 border-t border-slate-800 pt-4 mt-2">
                <div className="col-span-2"><h3 className="text-sm font-bold text-slate-300">Integração Telegram (Opcional)</h3></div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Bot Token</label>
                  <input type="text" value={formData.telegram_bot_token} onChange={e => setFormData({...formData, telegram_bot_token: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500 font-mono text-sm" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Chat ID</label>
                  <input type="text" value={formData.telegram_chat_id} onChange={e => setFormData({...formData, telegram_chat_id: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500 font-mono text-sm" placeholder="-100123456789" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-2 text-slate-400 hover:text-white font-semibold">Cancelar</button>
              <button type="submit" disabled={isSaving || !formData.name} className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-bold transition-colors">
                {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Store size={18} />} Salvar Loja
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {stores.map((store: any) => (
          <div key={store.id} className="bg-slate-900/60 border border-slate-800/80 p-6 rounded-2xl backdrop-blur-md hover:border-slate-600 transition-colors">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2"><Store size={20} className="text-blue-400" /> {store.name}</h3>
                <div className="text-slate-400 text-sm flex items-center gap-1.5 mt-1">
                  <MapPin size={14} /> {store.location || 'Sem localização'}
                </div>
              </div>
              <span className="text-xs font-bold bg-slate-800 text-slate-300 px-2 py-1 rounded">ID: {store.id}</span>
            </div>
            
            <div className="space-y-3 mt-6 border-t border-slate-800/80 pt-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-500 flex items-center gap-1.5"><Key size={14}/> API Key (Legado)</span>
                <span className="font-mono text-slate-300 bg-slate-950 px-2 py-0.5 rounded truncate max-w-[150px]" title={store.api_key}>
                  {store.api_key ? '••••' + store.api_key.slice(-4) : 'N/A'}
                </span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-500 flex items-center gap-1.5"><MessageSquare size={14}/> Telegram</span>
                <span className={`font-semibold ${store.telegram_bot_token ? 'text-emerald-400' : 'text-slate-600'}`}>
                  {store.telegram_bot_token ? 'Configurado' : 'Pendente'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
