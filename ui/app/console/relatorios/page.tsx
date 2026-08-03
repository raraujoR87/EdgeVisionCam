"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import {
  BarChart3, Target, ShieldAlert, Clock, Store as StoreIcon, Download, Info,
} from 'lucide-react';
import {
  Cartao, Cabecalho, Indicador, Carregando, Erro, Vazio, Barras, Botao, Selecao,
  buscar,
} from '../../../components/ui';
import { useConsole } from '../contexto';

/**
 * Relatórios.
 *
 * O corte que vira decisão: quando acontece (escala de pessoal), onde acontece
 * (qual loja concentra a perda) e se o sistema está acertando.
 *
 * A precisão nunca aparece sozinha. Ela é calculada sobre os alertas que
 * alguém classificou na triagem, e três julgados de duzentos não sustentam um
 * número — sustentam uma impressão. Com amostra pequena a tela diz isso em vez
 * de estampar "100% de acerto", que é o tipo de métrica que fecha contrato e
 * depois não se sustenta.
 */

const JANELAS = [
  { dias: 7, rotulo: '7 dias' },
  { dias: 30, rotulo: '30 dias' },
  { dias: 90, rotulo: '90 dias' },
];

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

export default function RelatoriosPage() {
  const { filtroOrg, sessao, orgAtiva } = useConsole();
  const [dias, setDias] = useState(30);
  const [loja, setLoja] = useState('');

  const consulta = [
    `dias=${dias}`, loja ? `store_id=${loja}` : '', filtroOrg,
  ].filter(Boolean).join('&');

  const { data, error, isLoading, mutate } = useSWR(`/api/console/relatorios?${consulta}`, buscar);

  const baixarCsv = () => {
    if (!data) return;
    // Exportação montada no cliente a partir do que já está na tela. Um
    // endpoint de CSV precisaria repetir toda a lógica de recorte, e divergir
    // dela silenciosamente é como um relatório passa a discordar do painel.
    const linhas = [
      ['dia', 'total', 'suspeitos', 'confirmados', 'falsos_alarmes'],
      ...data.serie.map((d: any) => [
        new Date(d.dia).toISOString().slice(0, 10), d.total, d.suspeitos, d.confirmados, d.falsos,
      ]),
    ];
    const csv = linhas.map((l) => l.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `visioncam-${dias}dias-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) return <div className="p-6 max-w-6xl mx-auto"><Carregando linhas={5} /></div>;
  if (error) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />
      </div>
    );
  }

  const t = data.totais;
  const q = data.qualidade;
  const lojasVisiveis = sessao?.lojas ?? [];

  const serie = data.serie.map((d: any) => ({
    rotulo: d.dia, valor: d.total, destaque: d.confirmados,
  }));
  const horas = data.por_hora.map((h: any) => ({
    rotulo: String(h.hora).padStart(2, '0'), valor: h.total, destaque: h.confirmados,
  }));

  const picoHora = data.por_hora.reduce(
    (a: any, b: any) => (b.total > (a?.total ?? -1) ? b : a), null as any);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Cabecalho
        Icone={BarChart3}
        titulo="Relatórios"
        descricao={orgAtiva ? `${orgAtiva.name} — últimos ${dias} dias.` : `Últimos ${dias} dias.`}
        acao={
          <Botao variante="secundario" Icone={Download} onClick={baixarCsv} disabled={!t.total}>
            Baixar CSV
          </Botao>
        }
      />

      <div className="flex flex-wrap items-end gap-3 mb-6">
        <div className="flex gap-1.5">
          {JANELAS.map((j) => (
            <button
              key={j.dias}
              onClick={() => setDias(j.dias)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                dias === j.dias
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100'
              }`}
            >
              {j.rotulo}
            </button>
          ))}
        </div>
        {lojasVisiveis.length > 1 && (
          <div className="w-52">
            <Selecao value={loja} onChange={(e) => setLoja(e.target.value)}>
              <option value="">Todas as lojas</option>
              {lojasVisiveis.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Selecao>
          </div>
        )}
      </div>

      {t.total === 0 ? (
        <Vazio
          titulo="Nenhum evento no período"
          descricao="Amplie a janela ou verifique, no painel, se os dispositivos estão comunicando."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <Indicador rotulo="Eventos" valor={t.total} Icone={BarChart3} />
            <Indicador
              rotulo="Suspeitos" valor={t.suspeitos} Icone={ShieldAlert}
              tom={t.suspeitos > 0 ? 'aviso' : 'neutro'}
            />
            <Indicador
              rotulo="Furtos confirmados" valor={t.confirmados} Icone={Target}
              tom={t.confirmados > 0 ? 'perigo' : 'neutro'}
            />
            <Indicador
              rotulo="Horário de pico"
              valor={picoHora && picoHora.total > 0 ? `${String(picoHora.hora).padStart(2, '0')}h` : '—'}
              Icone={Clock}
              nota={picoHora && picoHora.total > 0 ? `${picoHora.total} eventos` : 'sem concentração'}
            />
          </div>

          {/* Qualidade da detecção. É a seção que responde "vale o que custa" —
              e a única honesta o bastante para dizer quando ainda não sabe. */}
          <Cartao className="p-4 mb-6">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-sm font-medium text-slate-200">Qualidade da detecção</h2>
              <span className="text-[11px] text-slate-500">baseada na triagem feita pela sua equipe</span>
            </div>
            <div className="grid sm:grid-cols-3 gap-5">
              <div>
                <p className="text-xs text-slate-400 mb-1">Alertas que procediam</p>
                <p className={`text-2xl font-semibold tabular-nums ${
                  q.amostra_suficiente ? 'text-slate-100' : 'text-slate-500'
                }`}>
                  {pct(q.precisao)}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  {t.confirmados} de {t.julgados} classificados
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Cobertura da triagem</p>
                <p className="text-2xl font-semibold tabular-nums text-slate-100">{pct(q.cobertura)}</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  {t.total - t.julgados} evento(s) ainda sem classificação
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Falsos alarmes</p>
                <p className="text-2xl font-semibold tabular-nums text-slate-100">{t.falsos}</p>
                <p className="text-[11px] text-slate-500 mt-1">
                  score médio {t.score_medio != null ? Number(t.score_medio).toFixed(2) : '—'}
                </p>
              </div>
            </div>
            {!q.amostra_suficiente && (
              <p className="flex items-start gap-2 mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-500">
                <Info size={13} className="mt-px shrink-0" />
                Com {t.julgados} alerta(s) classificado(s), a taxa de acerto ainda é amostra pequena
                demais para tirar conclusão. Ela ganha significado a partir de 20 classificações.
              </p>
            )}
          </Cartao>

          <div className="grid lg:grid-cols-2 gap-5 mb-5">
            <Cartao className="p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-medium text-slate-200">Eventos por dia</h2>
                <span className="text-[11px] text-slate-500"><span className="text-red-400">vermelho</span> = confirmados</span>
              </div>
              <Barras dados={serie} altura={140} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-2">
                <span>{new Date(serie[0]?.rotulo).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                <span>hoje</span>
              </div>
            </Cartao>

            <Cartao className="p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-medium text-slate-200">Por hora do dia</h2>
                <span className="text-[11px] text-slate-500">horário de Brasília</span>
              </div>
              <Barras dados={horas} altura={140} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-2">
                <span>00h</span><span>12h</span><span>23h</span>
              </div>
            </Cartao>
          </div>

          {data.por_loja.length > 1 && (
            <Cartao className="p-4">
              <h2 className="text-sm font-medium text-slate-200 mb-3 flex items-center gap-2">
                <StoreIcon size={15} />Por loja
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                      <th className="text-left font-medium py-2">Loja</th>
                      <th className="text-right font-medium py-2">Eventos</th>
                      <th className="text-right font-medium py-2">Suspeitos</th>
                      <th className="text-right font-medium py-2">Confirmados</th>
                      <th className="text-right font-medium py-2">Falsos</th>
                      <th className="text-right font-medium py-2">Pendentes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.por_loja.map((l: any) => (
                      <tr key={l.id} className="border-b border-slate-800/60 last:border-0">
                        <td className="py-2.5">
                          <span className="text-slate-200">{l.name}</span>
                          {l.location && <span className="text-slate-600 text-xs ml-2">{l.location}</span>}
                        </td>
                        <td className="text-right tabular-nums text-slate-300">{l.total}</td>
                        <td className="text-right tabular-nums text-amber-400/90">{l.suspeitos}</td>
                        <td className="text-right tabular-nums text-red-400">{l.confirmados}</td>
                        <td className="text-right tabular-nums text-slate-500">{l.falsos}</td>
                        <td className="text-right tabular-nums text-slate-400">{l.pendentes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Cartao>
          )}
        </>
      )}
    </div>
  );
}
