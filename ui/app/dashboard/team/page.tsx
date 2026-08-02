"use client";

import React, { useState } from 'react';
import { Users, UserPlus, Trash2, Shield, Eye, Loader2 } from 'lucide-react';
import useSWR from 'swr';
import { getApiUrl } from '../../utils/api';

const fetcher = (url: string) => {
  const token = localStorage.getItem('admin_token');
  return fetch(url, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json());
};

export default function TeamPage() {
  const { data: users, error, mutate } = useSWR(getApiUrl('/api/users'), fetcher);
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('STORE_VIEWER');
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    setMessage('');
    
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch(getApiUrl('/api/users'), {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ email, password, role })
      });
      
      if (res.ok) {
        setEmail('');
        setPassword('');
        mutate();
        setMessage('Usuário criado com sucesso!');
      } else {
        const data = await res.json();
        setMessage(data.error || 'Erro ao criar usuário');
      }
    } catch (e) {
      setMessage('Erro de conexão.');
    } finally {
      setIsCreating(false);
    }
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'STORE_ADMIN': return <span className="bg-amber-500/20 text-amber-400 px-3 py-1 rounded-full text-xs font-bold border border-amber-500/30 flex items-center gap-1"><Shield size={12}/> Administrador</span>;
      case 'STORE_OPERATOR': return <span className="bg-blue-500/20 text-blue-400 px-3 py-1 rounded-full text-xs font-bold border border-blue-500/30 flex items-center gap-1"><Users size={12}/> Operador</span>;
      case 'STORE_VIEWER': return <span className="bg-slate-500/20 text-slate-400 px-3 py-1 rounded-full text-xs font-bold border border-slate-500/30 flex items-center gap-1"><Eye size={12}/> Visualizador</span>;
      default: return <span className="bg-slate-500/20 text-slate-400 px-3 py-1 rounded-full text-xs font-bold border border-slate-500/30">{role}</span>;
    }
  };

  if (!users) return <div className="p-8 flex items-center justify-center h-full"><Loader2 className="animate-spin text-blue-500" size={32}/></div>;

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
          <Users className="text-blue-500" size={32} />
          Gestão de Equipe
        </h1>
        <p className="text-slate-400 mt-2">
          Adicione gerentes, seguranças ou fiscais para terem acesso ao monitoramento da sua loja.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Formulário de Criação */}
        <div className="lg:col-span-1">
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
            <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
              <UserPlus size={20} className="text-blue-500"/>
              Novo Usuário
            </h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-slate-400">E-mail</label>
                <input 
                  type="email" 
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 w-full"
                  required
                />
              </div>
              
              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-slate-400">Senha Inicial</label>
                <input 
                  type="password" 
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 w-full"
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-slate-400">Nível de Acesso</label>
                <select 
                  value={role}
                  onChange={e => setRole(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500 w-full"
                >
                  <option value="STORE_OPERATOR">Operador (Monitoramento em tempo real)</option>
                  <option value="STORE_VIEWER">Visualizador (Apenas relatórios e BI)</option>
                </select>
              </div>

              {message && (
                <div className={`p-3 rounded-lg text-sm font-medium ${message.includes('Erro') ? 'bg-rose-950/50 text-rose-400' : 'bg-emerald-950/50 text-emerald-400'}`}>
                  {message}
                </div>
              )}

              <button 
                type="submit"
                disabled={isCreating}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-xl font-bold transition-colors flex items-center justify-center gap-2 mt-4"
              >
                {isCreating ? <Loader2 className="animate-spin" size={20}/> : <UserPlus size={20}/>}
                Cadastrar Usuário
              </button>
            </form>
          </div>
        </div>

        {/* Lista de Usuários */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/50">
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">E-mail</th>
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wide">Cargo</th>
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wide text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-8 text-center text-slate-500">Nenhum usuário cadastrado</td>
                  </tr>
                ) : (
                  users.map((u: any) => (
                    <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="p-4 text-slate-200 font-medium">{u.email}</td>
                      <td className="p-4">{getRoleBadge(u.role)}</td>
                      <td className="p-4 text-right">
                        {u.role !== 'STORE_ADMIN' && (
                          <button className="text-slate-500 hover:text-rose-400 p-2 transition-colors">
                            <Trash2 size={18} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
