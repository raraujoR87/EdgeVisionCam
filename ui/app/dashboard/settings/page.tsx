"use client";

import React, { useEffect, useState } from 'react';
import { Cog, Save, Loader2, Info } from 'lucide-react';
import useSWR from 'swr';
import { getApiUrl } from '../../utils/api';

const fetcher = (url: string) => {
  const token = localStorage.getItem('admin_token');
  return fetch(url, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json());
};

export default function SettingsPage() {
  const { data: stores, mutate } = useSWR(getApiUrl('/api/stores'), fetcher);
  const [session, setSession] = useState<any>(null);
  
  // States
  const [businessRules, setBusinessRules] = useState('');
  const [openTime, setOpenTime] = useState('08:00');
  const [closeTime, setCloseTime] = useState('22:00');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      setSession(payload);
    }
  }, []);

  const myStore = stores?.find((s: any) => s.id === session?.store_id) || stores?.[0];

  useEffect(() => {
    if (myStore) {
      setBusinessRules(myStore.business_rules || '');
      if (myStore.operating_hours) {
        try {
          const oh = typeof myStore.operating_hours === 'string' ? JSON.parse(myStore.operating_hours) : myStore.operating_hours;
          setOpenTime(oh.open || '08:00');
          setCloseTime(oh.close || '22:00');
        } catch(e) {}
      }
    }
  }, [myStore]);

  const handleSave = async () => {
    if (!myStore) return;
    setIsSaving(true);
    setMessage('');
    
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch(getApiUrl('/api/stores'), {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
          id: myStore.id,
          business_rules: businessRules,
          operating_hours: { open: openTime, close: closeTime }
        })
      });
      
      if (res.ok) {
        setMessage('Configurações salvas com sucesso!');
        mutate();
      } else {
        setMessage('Erro ao salvar as configurações.');
      }
    } catch (e) {
      setMessage('Erro de conexão.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!stores || !session) return <div className="p-8 flex items-center justify-center h-full"><Loader2 className="animate-spin text-blue-500" size={32}/></div>;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
          <Cog className="text-blue-500" size={32} />
          Regras de Negócio e IA
        </h1>
        <p className="text-slate-400 mt-2">
          Personalize como a Inteligência Artificial (Gemini) enxerga sua loja. O contexto preenchido aqui guiará as análises de vídeo.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
        <h2 className="text-xl font-bold text-white mb-4">Horário de Funcionamento</h2>
        <div className="flex gap-4 items-center">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Abertura</label>
            <input 
              type="time" 
              value={openTime}
              onChange={e => setOpenTime(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Fechamento</label>
            <input 
              type="time" 
              value={closeTime}
              onChange={e => setCloseTime(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-3 flex items-center gap-1">
          <Info size={14}/> Eventos fora do horário de funcionamento receberão um nível de severidade maior na auditoria.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
        <h2 className="text-xl font-bold text-white mb-4">Contexto para o Gemini</h2>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-semibold text-slate-400">Regras e Dinâmicas da Loja</label>
          <textarea 
            value={businessRules}
            onChange={e => setBusinessRules(e.target.value)}
            rows={5}
            placeholder="Exemplo: 'Temos um setor de joias próximo ao caixa onde clientes costumam parar por muito tempo, não é atitude suspeita. Porém, se alguém entrar de capacete, alerte imediatamente.'"
            className="bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 w-full resize-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className={`text-sm ${message.includes('Erro') ? 'text-rose-400' : 'text-emerald-400'}`}>
          {message}
        </p>
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-bold transition-colors flex items-center gap-2"
        >
          {isSaving ? <Loader2 className="animate-spin" size={20}/> : <Save size={20}/>}
          Salvar Configurações
        </button>
      </div>
    </div>
  );
}
