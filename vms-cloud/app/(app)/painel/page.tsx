"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { BarChart3, ShieldAlert, CheckCircle2, XCircle, Camera, Gauge, AlertTriangle } from 'lucide-react';
import { Cabecalho, Cartao, Indicador, Barras, Carregando, Erro, Medidor, Botao, buscar } from '../../../components/ui';
import { useApp } from '../../../components/contexto-app';

/**
 * Painel. Responde: o sistema está analisando? quantos alertas? estou acertando?
 * e quanto do plano já foi consumido.
 */

const JANELAS = [
  { dias: 1, rotulo: 'Hoje' },
  { dias: 7, rotulo: '7 dias' },
  { dias: 30, rotulo: '30 dias' },
];

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

export default function PainelPage() {
  const { filtroOrg } = useApp();
  const [dias, setDias] = useState(7);
  const { data, error, isLoading, mutate } = useSWR(
    `/api/bi?dias=${dias}${filtroOrg ? `&${filtroOrg}` : ''}`,
    buscar,
    { refreshInterval: 60_000 },
  );

  if (isLoading) return <div className="p-6 max-w-6xl mx-auto"><Carregando linhas={4} /></div>;
  if (error) return <div className="p-6 max-w-6xl mx-auto"><Erro mensagem={error.message} aoTentarNovamente={() => mutate()} /></div>;

  const t = data.totais;
  const serie = data.serie.map((d: any) => ({ rotulo: d.dia, valor: d.total, destaque: d.procede }));
  const cota = data.cotas[0];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Cabecalho
        Icone={BarChart3}
        titulo="Painel"
        descricao="Eventos analisados pela IA, revisões da equipe e consumo do plano."
        acao={
          <div className="flex gap-1.5">
            {JANELAS.map((j) => (
              <button key={j.dias} onClick={() => setDias(j.dias)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  dias === j.dias ? 'bg-sky-600 text-white' : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100'
                }`}>{j.rotulo}</button>
            ))}
          </div>
        }
      />

      {t.total === 0 ? (
        <Cartao className="p-8 text-center">
          <Camera size={32} className="mx-auto mb-3 text-slate-700" />
          <p className="text-sm font-medium text-slate-300">Nenhum evento recebido no período</p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            Instale um agente em um local e ele começa a enviar eventos. Se já instalou e nada chegou,
            confira em <b>Locais e agentes</b> se o agente aparece como visto recentemente.
          </p>
        </Cartao>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <Indicador rotulo="Eventos analisados" valor={t.total - t.em_analise} Icone={BarChart3}
              nota={t.em_analise ? `${t.em_analise} aguardando análise` : undefined} />
            <Indicador rotulo="Suspeitos" valor={t.suspeitos} Icone={ShieldAlert}
              tom={t.suspeitos ? 'aviso' : 'neutro'}
              nota={t.suspeitos_sem_revisao ? `${t.suspeitos_sem_revisao} sem revisão` : 'todos revisados'} />
            <Indicador rotulo="Alertas que procediam" valor={t.procede} Icone={CheckCircle2} tom="perigo"
              nota={`${t.falso_alarme} falso(s) alarme(s)`} />
            <Indicador rotulo="Falhas de análise" valor={t.falhas} Icone={AlertTriangle}
              tom={t.falhas ? 'aviso' : 'sucesso'} nota={t.falhas ? 'veja em Eventos' : 'nenhuma'} />
          </div>

          <div className="grid lg:grid-cols-3 gap-5 mb-6">
            <Cartao className="p-4 lg:col-span-2">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-medium text-slate-200">Eventos por dia</h2>
                <span className="text-[11px] text-slate-500"><span className="text-red-400">vermelho</span> = alertas que procediam</span>
              </div>
              <Barras dados={serie} altura={130} />
            </Cartao>

            <Cartao className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Gauge size={15} className="text-slate-400" />
                <h2 className="text-sm font-medium text-slate-200">Acerto da IA</h2>
              </div>
              <p className={`text-3xl font-semibold tabular-nums ${data.amostra_suficiente ? 'text-slate-100' : 'text-slate-500'}`}>
                {pct(data.precisao)}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                {data.julgados} revisão(ões) humanas
              </p>
              {!data.amostra_suficiente && (
                <p className="text-[11px] text-slate-500 mt-3 pt-3 border-t border-slate-800">
                  Com menos de 20 revisões, a taxa ainda não significa nada. Continue revisando os alertas.
                </p>
              )}
              {cota && (
                <div className="mt-5 pt-4 border-t border-slate-800 space-y-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Plano {cota.plano}</p>
                  <Medidor atual={cota.eventos_mes} limite={cota.eventos_mes_limite} rotulo="Eventos no mês" />
                  <Medidor atual={cota.cameras} limite={cota.cameras_limite} rotulo="Câmeras" Icone={Camera} />
                </div>
              )}
            </Cartao>
          </div>

          <Cartao className="p-4">
            <h2 className="text-sm font-medium text-slate-200 mb-3">Câmeras com mais eventos</h2>
            {data.cameras.length === 0 ? (
              <p className="text-xs text-slate-500">Nenhuma câmera registrada ainda.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                      <th className="text-left font-medium py-2">Câmera</th>
                      <th className="text-left font-medium py-2">Local</th>
                      <th className="text-right font-medium py-2">Eventos</th>
                      <th className="text-right font-medium py-2">Suspeitos</th>
                      <th className="text-right font-medium py-2">Procediam</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cameras.map((c: any) => (
                      <tr key={c.id} className="border-b border-slate-800/60 last:border-0">
                        <td className="py-2.5 text-slate-200">{c.name}</td>
                        <td className="py-2.5 text-slate-500">{c.local}</td>
                        <td className="text-right tabular-nums text-slate-300">{c.total}</td>
                        <td className="text-right tabular-nums text-amber-400/90">{c.suspeitos}</td>
                        <td className="text-right tabular-nums text-red-400">{c.procede}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Cartao>
        </>
      )}
    </div>
  );
}
