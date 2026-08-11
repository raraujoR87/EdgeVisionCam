"use client"
import React, { useState } from 'react'
import useSWR from 'swr'
import { Loader2, Radio, X, Ban, ChevronDown, ChevronRight } from 'lucide-react'
import { COMANDOS, SERVICOS } from '../../api/comandos'

/**
 * Painel de controle remoto de um appliance.
 *
 * O ponto delicado desta tela é não parecer um terminal. Um botão que responde
 * na hora ensina o operador a esperar tempo real, e a frota não funciona assim:
 * o appliance está atrás do NAT da loja e busca a fila no próximo contato. Um
 * comando enfileirado para uma loja com o link caído executa quando ela voltar
 * — ou vence sozinho, se demorar demais.
 *
 * Por isso o estado exibido é o da fila, com carimbo de hora em cada etapa, e o
 * texto fala em "aguardando o appliance", não em "executando".
 */

const fetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('admin_token') : null
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then((r) => r.json())
}

interface Comando {
  id: number
  comando: string
  parametros: Record<string, unknown> | null
  status: string
  resultado: any
  issued_email: string | null
  created_at: string
  delivered_at: string | null
  completed_at: string | null
}

/** Cor por estado. Verde só no que terminou bem — o resto não deve tranquilizar. */
const APARENCIA_STATUS: Record<string, string> = {
  PENDENTE: 'bg-blue-950/40 text-blue-400 border-blue-800/40',
  ENTREGUE: 'bg-amber-950/40 text-amber-400 border-amber-800/40',
  CONCLUIDO: 'bg-emerald-950/40 text-emerald-400 border-emerald-800/40',
  FALHOU: 'bg-rose-950/40 text-rose-400 border-rose-800/40',
  SEM_RESPOSTA: 'bg-rose-950/40 text-rose-400 border-rose-800/40',
  EXPIRADO: 'bg-slate-800 text-slate-500 border-slate-700',
  CANCELADO: 'bg-slate-800 text-slate-500 border-slate-700',
}

const LEGENDA_STATUS: Record<string, string> = {
  PENDENTE: 'Na fila, aguardando o próximo contato do appliance.',
  ENTREGUE: 'O appliance recebeu e está executando.',
  CONCLUIDO: 'Executado.',
  FALHOU: 'O appliance recusou ou não conseguiu executar.',
  SEM_RESPOSTA: 'Recebido, mas o appliance não reportou o desfecho.',
  EXPIRADO: 'Venceu na fila antes de o appliance voltar a falar com a nuvem.',
  CANCELADO: 'Cancelado antes de ser entregue.',
}

function hora(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export default function ControleRemoto({
  applianceId,
  nomeDaLoja,
  aoFechar,
}: {
  applianceId: number
  nomeDaLoja: string
  aoFechar: () => void
}) {
  const { data, mutate, isLoading } = useSWR(
    `/api/commands?appliance_id=${applianceId}`,
    fetcher,
    // Um comando pendente muda de estado sem ninguém mexer na tela. Sem o
    // refresh o operador clicaria de novo achando que não pegou.
    { refreshInterval: 5000 },
  )

  const [enviando, setEnviando] = useState('')
  const [erro, setErro] = useState('')
  const [servico, setServico] = useState<string>('engine')
  const [aberto, setAberto] = useState<number | null>(null)

  const comandos: Comando[] = data?.comandos || []

  const enviar = async (nome: string) => {
    const definicao = COMANDOS[nome]

    // Confirmação só no que tira a loja do ar. Pedir "tem certeza?" para ler
    // log treina o operador a clicar em OK sem ler — e aí a confirmação que
    // importa também passa batida.
    if (definicao.interrompeDeteccao) {
      const texto = `${definicao.rotulo} em "${nomeDaLoja}".\n\n${definicao.descricao}\n\nContinuar?`
      if (!confirm(texto)) return
    }

    setErro('')
    setEnviando(nome)
    try {
      const token = localStorage.getItem('admin_token')
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          appliance_id: applianceId,
          comando: nome,
          parametros: nome === 'coletar_logs' ? { servico } : {},
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setErro(json.error || 'Falha ao enfileirar o comando.')
        return
      }
      mutate()
    } catch {
      setErro('Erro de rede.')
    } finally {
      setEnviando('')
    }
  }

  const cancelar = async (id: number) => {
    const token = localStorage.getItem('admin_token')
    await fetch(`/api/commands?id=${id}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    mutate()
  }

  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-white flex items-center gap-2">
            <Radio size={15} className="text-blue-500" /> Controle remoto — {nomeDaLoja}
          </h3>
          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed max-w-2xl">
            O appliance busca a fila a cada poucos segundos, então o comando executa no
            próximo contato dele — não instantaneamente. Se a loja estiver sem link, ele
            vence sozinho em 15 minutos em vez de rodar fora de hora.
          </p>
        </div>
        <button onClick={aoFechar} className="p-2 text-slate-500 hover:text-white transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Botões de comando */}
      <div className="flex flex-wrap items-end gap-3">
        {Object.entries(COMANDOS).map(([nome, definicao]) => (
          <button
            key={nome}
            onClick={() => enviar(nome)}
            disabled={!!enviando}
            title={definicao.descricao}
            className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all
              inline-flex items-center gap-2 disabled:opacity-50
              ${definicao.interrompeDeteccao
                ? 'bg-amber-500/10 text-amber-300 border border-amber-700/40 hover:bg-amber-500/20'
                : 'bg-white/5 text-slate-300 border border-slate-700 hover:bg-white/10'}`}
          >
            {enviando === nome && <Loader2 className="animate-spin" size={13} />}
            {definicao.rotulo}
          </button>
        ))}

        <div>
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">
            Serviço (para os logs)
          </label>
          <select
            value={servico}
            onChange={(e) => setServico(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-blue-500"
          >
            {SERVICOS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {erro && (
        <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl p-3">
          {erro}
        </div>
      )}

      {/* Histórico */}
      <div>
        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">
          Últimos comandos
        </div>

        {isLoading ? (
          <Loader2 className="animate-spin text-slate-600" size={16} />
        ) : comandos.length === 0 ? (
          <div className="text-xs text-slate-600">Nenhum comando enviado a este appliance.</div>
        ) : (
          <div className="space-y-2">
            {comandos.map((c) => (
              <div key={c.id} className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
                <div className="flex items-center gap-3 p-3">
                  <button
                    onClick={() => setAberto(aberto === c.id ? null : c.id)}
                    className="text-slate-500 hover:text-white transition-colors"
                    aria-label="Detalhes"
                  >
                    {aberto === c.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>

                  <span className="font-mono text-xs text-slate-300 flex-1">
                    {COMANDOS[c.comando]?.rotulo || c.comando}
                  </span>

                  <span
                    title={LEGENDA_STATUS[c.status] || ''}
                    className={`px-2 py-1 rounded text-[10px] font-bold border ${
                      APARENCIA_STATUS[c.status] || 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {c.status}
                  </span>

                  <span className="text-[10px] text-slate-600 w-32 text-right">{hora(c.created_at)}</span>

                  {c.status === 'PENDENTE' && (
                    <button
                      onClick={() => cancelar(c.id)}
                      className="text-slate-500 hover:text-rose-400 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider"
                    >
                      <Ban size={11} /> cancelar
                    </button>
                  )}
                </div>

                {aberto === c.id && (
                  <div className="px-3 pb-3 pl-10 space-y-2 text-[11px] text-slate-500">
                    <div>{LEGENDA_STATUS[c.status] || ''}</div>
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                      <span>por {c.issued_email || '—'}</span>
                      <span>entregue: {hora(c.delivered_at)}</span>
                      <span>concluído: {hora(c.completed_at)}</span>
                    </div>
                    {c.resultado && (
                      // Log de container vem com quebras de linha e largura
                      // própria; <pre> com rolagem evita que ele estique a
                      // tabela da frota inteira.
                      <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto max-h-72 overflow-y-auto text-[10px] text-slate-400 whitespace-pre-wrap break-all">
                        {typeof c.resultado.logs === 'string'
                          ? c.resultado.logs
                          : JSON.stringify(c.resultado, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
