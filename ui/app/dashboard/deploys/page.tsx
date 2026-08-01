"use client"
import React, { useState } from 'react'
import useSWR from 'swr'
import { Server, Plus, Copy, Check, Ban, Loader2, AlertTriangle, Clock } from 'lucide-react'
import { classificarLoja, APARENCIA } from '../fleet'

/**
 * Gerenciamento de deploys da frota.
 *
 * O técnico em campo não digita mais credenciais: a loja é preparada aqui, a
 * nuvem emite um código curto, e na loja ele digita só esse código.
 */

const fetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('admin_token') : null
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then((r) => r.json())
}

interface Appliance {
  id: number
  store_id: number
  store_name: string
  status: 'PENDENTE' | 'ATIVO' | 'REVOGADO'
  target_version: string
  label: string | null
  codigo: string | null
  expires_at: string | null
  claimed_at: string | null
  tem_edge_key: boolean
  last_seen: string | null
  inference_ms: number | null
}

export default function GerenciarDeploys() {
  const { data, mutate, isLoading } = useSWR('/api/provisioning', fetcher, {
    refreshInterval: 10000,
  })
  const { data: lojas } = useSWR('/api/stores', fetcher)

  const [criando, setCriando] = useState(false)
  const [copiado, setCopiado] = useState<number | null>(null)
  const [erro, setErro] = useState('')
  const [form, setForm] = useState({ store_id: '', label: '', target_version: 'latest', edge_key: '' })

  const appliances: Appliance[] = data?.appliances || []
  const pendentes = appliances.filter((a) => a.status === 'PENDENTE')

  const autorizado = () => {
    const token = localStorage.getItem('admin_token')
    return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : undefined
  }

  const criar = async (e: React.FormEvent) => {
    e.preventDefault()
    setErro('')
    if (!form.store_id) {
      setErro('Selecione a loja.')
      return
    }
    setCriando(true)
    try {
      const res = await fetch('/api/provisioning', {
        method: 'POST',
        headers: autorizado(),
        body: JSON.stringify({ ...form, store_id: Number(form.store_id) }),
      })
      const json = await res.json()
      if (!res.ok) {
        setErro(json.error || 'Falha ao emitir código.')
        return
      }
      setForm({ store_id: '', label: '', target_version: 'latest', edge_key: '' })
      mutate()
    } catch {
      setErro('Erro de rede.')
    } finally {
      setCriando(false)
    }
  }

  const revogar = async (a: Appliance) => {
    const aviso = a.status === 'ATIVO'
      ? `O appliance de "${a.store_name}" já foi provisionado. Revogar impede um novo `
        + 'resgate, mas ele continua operando com a chave que recebeu. Continuar?'
      : `Revogar o código de "${a.store_name}"?`
    if (!confirm(aviso)) return

    await fetch(`/api/provisioning?id=${a.id}`, { method: 'DELETE', headers: autorizado() })
    mutate()
  }

  const copiar = (a: Appliance) => {
    if (!a.codigo) return
    navigator.clipboard.writeText(a.codigo)
    setCopiado(a.id)
    setTimeout(() => setCopiado(null), 2000)
  }

  const venceEm = (iso: string | null) => {
    if (!iso) return null
    const horas = (new Date(iso).getTime() - Date.now()) / 3600000
    if (horas < 0) return 'vencido'
    if (horas < 24) return `vence em ${Math.round(horas)}h`
    return `vence em ${Math.round(horas / 24)}d`
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
          Deploys da Frota
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Emita um código por appliance. Em campo, o técnico digita só o código —
          nenhuma credencial passa pela mão dele.
        </p>
      </div>

      {/* Emissão */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-md">
        <h2 className="text-lg font-bold flex items-center gap-2 mb-5">
          <Plus size={18} className="text-blue-500" /> Preparar novo appliance
        </h2>

        <form onSubmit={criar} className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
          <div className="md:col-span-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Loja</label>
            <select
              value={form.store_id}
              onChange={(e) => setForm({ ...form, store_id: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-blue-500"
            >
              <option value="">Selecione…</option>
              {(lojas?.stores || []).map((l: any) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Identificação</label>
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="ex: caixa-01"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Versão</label>
            <input
              value={form.target_version}
              onChange={(e) => setForm({ ...form, target_version: e.target.value })}
              placeholder="v1.0.0"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <button
            type="submit"
            disabled={criando}
            className="py-3 px-6 bg-white hover:bg-blue-600 hover:text-white text-slate-950 font-black text-xs uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {criando ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
            Emitir código
          </button>

          <div className="md:col-span-5">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">
              Portainer Edge Key (opcional — sem ela o appliance não entra na gerência central)
            </label>
            <input
              value={form.edge_key}
              onChange={(e) => setForm({ ...form, edge_key: e.target.value })}
              placeholder="Cole a Edge key gerada no Portainer"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-blue-500 font-mono"
            />
          </div>
        </form>

        {erro && (
          <div className="mt-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl p-3">
            {erro}
          </div>
        )}
      </div>

      {/* Códigos pendentes em destaque */}
      {pendentes.length > 0 && (
        <div className="bg-blue-950/20 border border-blue-800/30 rounded-2xl p-6">
          <h2 className="text-sm font-black text-blue-300 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Clock size={16} /> Aguardando instalação
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {pendentes.map((a) => (
              <div key={a.id} className="bg-slate-950/60 border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="text-xs text-slate-400 font-medium">{a.store_name}</div>
                <div className="flex items-center gap-3">
                  <code className="text-2xl font-black tracking-[0.15em] text-white font-mono">
                    {a.codigo}
                  </code>
                  <button
                    onClick={() => copiar(a)}
                    className="p-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                    title="Copiar"
                  >
                    {copiado === a.id ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  </button>
                </div>
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
                  <span className="text-amber-400 font-bold">{venceEm(a.expires_at)}</span>
                  <button onClick={() => revogar(a)} className="text-slate-500 hover:text-rose-400 flex items-center gap-1">
                    <Ban size={11} /> revogar
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-blue-300/60 mt-4 leading-relaxed">
            Na loja: ligue o Radxa na rede, acesse <code className="text-blue-300">http://IP-DA-PLACA:8080</code>,
            digite o código e clique em Instalar. O código se queima no primeiro uso.
          </p>
        </div>
      )}

      {/* Frota */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl backdrop-blur-md overflow-hidden">
        <div className="p-6 border-b border-slate-800/80">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Server size={18} className="text-blue-500" /> Appliances
          </h2>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-slate-500">
            <Loader2 className="animate-spin mx-auto" size={24} />
          </div>
        ) : appliances.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-sm">
            Nenhum appliance preparado ainda.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800/80 text-xs font-bold text-slate-500 uppercase">
                  <th className="p-5">Loja / Identificação</th>
                  <th className="p-5">Provisionamento</th>
                  <th className="p-5">Versão</th>
                  <th className="p-5">Saúde</th>
                  <th className="p-5">Gerência</th>
                  <th className="p-5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40 text-sm">
                {appliances.map((a) => {
                  const saude = APARENCIA[classificarLoja(a)]
                  return (
                    <tr key={a.id} className="hover:bg-slate-800/20 transition-colors">
                      <td className="p-5">
                        <div className="font-bold text-white">{a.store_name}</div>
                        {a.label && <div className="text-xs text-slate-500">{a.label}</div>}
                      </td>
                      <td className="p-5">
                        {a.status === 'PENDENTE' && (
                          <span className="px-2 py-1 rounded text-[10px] font-bold bg-blue-950/40 text-blue-400 border border-blue-800/40">
                            AGUARDANDO
                          </span>
                        )}
                        {a.status === 'ATIVO' && (
                          <div>
                            <span className="px-2 py-1 rounded text-[10px] font-bold bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
                              PROVISIONADO
                            </span>
                            {a.claimed_at && (
                              <div className="text-[10px] text-slate-600 mt-1">
                                {new Date(a.claimed_at).toLocaleDateString('pt-BR')}
                              </div>
                            )}
                          </div>
                        )}
                        {a.status === 'REVOGADO' && (
                          <span className="px-2 py-1 rounded text-[10px] font-bold bg-slate-800 text-slate-500 border border-slate-700">
                            REVOGADO
                          </span>
                        )}
                      </td>
                      <td className="p-5 font-mono text-xs text-slate-300">{a.target_version}</td>
                      <td className="p-5">
                        {a.status === 'ATIVO' ? (
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${saude.ponto}`} />
                            <span className={`text-xs ${saude.classe}`}>{saude.rotulo}</span>
                          </div>
                        ) : (
                          <span className="text-slate-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="p-5">
                        {a.tem_edge_key ? (
                          <span className="text-xs text-emerald-400">Portainer Edge</span>
                        ) : (
                          <span className="text-xs text-slate-600 flex items-center gap-1">
                            <AlertTriangle size={11} /> sem gerência
                          </span>
                        )}
                      </td>
                      <td className="p-5 text-right">
                        {a.status !== 'REVOGADO' && (
                          <button
                            onClick={() => revogar(a)}
                            className="text-xs text-slate-500 hover:text-rose-400 inline-flex items-center gap-1"
                          >
                            <Ban size={12} /> Revogar
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
