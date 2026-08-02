"use client";

import React from 'react';
import { BarChart3, Activity, Crosshair, AlertTriangle, Loader2 } from 'lucide-react';
import useSWR from 'swr';
import { getApiUrl } from '../../utils/api';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const fetcher = (url: string) => {
  const token = localStorage.getItem('admin_token');
  return fetch(url, { headers: { 'Authorization': `Bearer ${token}` } }).then(res => res.json());
};

const COLORS = ['#10b981', '#f43f5e', '#64748b'];

export default function AnalyticsPage() {
  const { data, error } = useSWR(getApiUrl('/api/analytics'), fetcher);

  if (!data) return <div className="p-8 flex items-center justify-center h-full"><Loader2 className="animate-spin text-blue-500" size={32}/></div>;
  if (data.error) return <div className="p-8 text-rose-500">{data.error}</div>;

  const { daily, feedback, fleet } = data;

  const pieData = [
    { name: 'Positivos Verdadeiros', value: Number(feedback?.true_positives || 0) },
    { name: 'Falsos Positivos', value: Number(feedback?.false_positives || 0) }
  ];

  const precision = feedback?.total_feedback > 0 
    ? Math.round((Number(feedback.true_positives) / Number(feedback.total_feedback)) * 100) 
    : 0;

  return (
    <div className="max-w-7xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
          <BarChart3 className="text-blue-500" size={32} />
          Business Intelligence (BI)
        </h1>
        <p className="text-slate-400 mt-2">
          Visão geral do sistema e performance da Inteligência Artificial.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Precisão da IA</p>
              <h3 className="text-4xl font-black text-white mt-2">{precision}%</h3>
            </div>
            <div className="bg-blue-500/20 p-3 rounded-xl"><Crosshair size={24} className="text-blue-400"/></div>
          </div>
          <p className="text-xs text-slate-500 mt-4">Baseado no feedback humano dos eventos.</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Eventos Suspeitos Hoje</p>
              <h3 className="text-4xl font-black text-amber-400 mt-2">
                {daily?.length > 0 ? daily[daily.length - 1].suspicious : 0}
              </h3>
            </div>
            <div className="bg-amber-500/20 p-3 rounded-xl"><AlertTriangle size={24} className="text-amber-400"/></div>
          </div>
          <p className="text-xs text-slate-500 mt-4">Furtos em potencial identificados.</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Saúde da Frota</p>
              <h3 className="text-4xl font-black text-emerald-400 mt-2">
                {fleet?.online || 0} <span className="text-xl text-slate-500">/ {fleet?.total_appliances || 0}</span>
              </h3>
            </div>
            <div className="bg-emerald-500/20 p-3 rounded-xl"><Activity size={24} className="text-emerald-400"/></div>
          </div>
          <p className="text-xs text-slate-500 mt-4">Dispositivos conectados nos últimos 5 min.</p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Bar Chart */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <h2 className="text-xl font-bold text-white mb-6">Volume de Eventos (Últimos 7 dias)</h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickFormatter={(val) => new Date(val).toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'})} />
                <YAxis stroke="#94a3b8" fontSize={12} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                  itemStyle={{ color: '#f8fafc' }}
                />
                <Legend />
                <Bar dataKey="suspicious" name="Suspeitos" stackId="a" fill="#f59e0b" radius={[0, 0, 4, 4]} />
                <Bar dataKey="clear" name="Livre de Suspeita" stackId="a" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie Chart */}
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col">
          <h2 className="text-xl font-bold text-white mb-2">Desempenho da IA</h2>
          <p className="text-sm text-slate-400 mb-6">Auditoria humana sobre as decisões do modelo de visão computacional.</p>
          <div className="h-64 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                  itemStyle={{ color: '#f8fafc' }}
                />
                <Legend verticalAlign="bottom" height={36}/>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  );
}
