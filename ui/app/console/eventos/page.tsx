"use client"
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import {
  ListChecks, ShieldAlert, CheckCircle2, XCircle, Undo2, Film,
  Clock, MapPin, Gauge, Keyboard, ChevronRight,
} from 'lucide-react';
import {
  Cartao, Cabecalho, Emblema, Carregando, Vazio, Erro, Paginacao,
  Botao, Selecao, buscar, enviar, quando, faz,
} from '../../../components/ui';
import { useConsole } from '../contexto';

/**
 * Triagem — a tela do produto.
 *
 * Tudo o mais no sistema existe para produzir esta fila: a borda detecta, a
 * nuvem guarda, e aqui uma pessoa olha o clipe e diz se procede. Enquanto isso
 * não acontecia em lugar nenhum, o cliente tinha um detector, não um produto.
 *
 * Três decisões que moldaram o desenho:
 *
 * 1. **A fila é o padrão, não a lista completa.** Abrir em "tudo" transforma
 *    triagem em rolar procurando o que falta julgar.
 * 2. **Julgar avança sozinho para o próximo.** Sem isso, cada alerta custa dois
 *    cliques a mais, e uma fila de quarenta vira trabalho que ninguém faz.
 * 3. **Dá para desfazer.** Um fiscal que não pode corrigir um clique errado
 *    passa a não clicar — e a fila para de refletir a realidade, que é
 *    justamente o dado do qual sai a medição de acurácia.
 */

const POR_PAGINA = 20;

const VEREDICTO: Record<string, { rotulo: string; tom: 'perigo' | 'sucesso' | 'info' | 'neutro' }> = {
  SUSPICIOUS: { rotulo: 'Suspeito', tom: 'perigo' },
  CLEAR: { rotulo: 'Sem indício', tom: 'sucesso' },
  EXCULPATORY: { rotulo: 'Justificado', tom: 'info' },
};

const FILTROS = [
  { id: 'pendentes', rotulo: 'Aguardando triagem' },
  { id: 'suspeitos', rotulo: 'Suspeitos' },
  { id: 'confirmados', rotulo: 'Confirmados' },
  { id: 'falsos', rotulo: 'Falsos alarmes' },
  { id: 'todos', rotulo: 'Todos' },
];

interface Evento {
  id: number;
  store_id: number;
  store_name: string | null;
  store_location: string | null;
  video_url: string | null;
  suspicion_score: string | number | null;
  verdict: string | null;
  verdict_explanation: string | null;
  human_feedback: string | null;
  analyzed_at: string;
  telemetry: any;
}

function consultaDoFiltro(filtro: string): string {
  switch (filtro) {
    case 'pendentes': return 'pendentes=1';
    case 'suspeitos': return 'verdict=SUSPICIOUS';
    case 'confirmados': return 'feedback=TRUE_POSITIVE';
    case 'falsos': return 'feedback=FALSE_POSITIVE';
    default: return '';
  }
}

function Triagem() {
  const params = useSearchParams();
  const { filtroOrg, papelNaOrg, sessao } = useConsole();

  const [filtro, setFiltro] = useState(params.get('pendentes') === '1' ? 'pendentes' : 'pendentes');
  const [loja, setLoja] = useState(params.get('store_id') ?? '');
  const [pagina, setPagina] = useState(0);
  const [selecionado, setSelecionado] = useState<number | null>(null);
  const [salvando, setSalvando] = useState<number | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // STORE_VIEWER lê e não julga. A regra também está na rota; aqui é só para
  // não oferecer um botão que voltaria 403.
  const podeJulgar = papelNaOrg !== 'STORE_VIEWER';

  const url = useMemo(() => {
    const q = [
      consultaDoFiltro(filtro),
      loja ? `store_id=${loja}` : '',
      filtroOrg,
      `limit=${POR_PAGINA}`,
      `offset=${pagina * POR_PAGINA}`,
    ].filter(Boolean).join('&');
    return `/api/events?${q}`;
  }, [filtro, loja, filtroOrg, pagina]);

  const { data, error, isLoading, mutate } = useSWR(url, buscar, { refreshInterval: 60_000 });

  const eventos: Evento[] = data?.eventos ?? [];
  const resumo = data?.resumo;

  // Seleciona o primeiro assim que a lista chega, para que a tela abra pronta
  // para trabalhar em vez de pedir um clique antes de mostrar qualquer coisa.
  useEffect(() => {
    if (eventos.length && !eventos.some((e) => e.id === selecionado)) {
      setSelecionado(eventos[0].id);
    }
    if (!eventos.length) setSelecionado(null);
  }, [eventos, selecionado]);

  const indice = eventos.findIndex((e) => e.id === selecionado);
  const atual = indice >= 0 ? eventos[indice] : null;

  const julgar = useCallback(async (evento: Evento, feedback: string | null) => {
    if (!podeJulgar) return;
    setSalvando(evento.id);
    setAviso(null);

    const seguinte = eventos[eventos.findIndex((e) => e.id === evento.id) + 1];

    try {
      await enviar('/api/events', 'PATCH', { id: evento.id, human_feedback: feedback });
      // Na fila de pendentes o item julgado sai da lista; em qualquer outra
      // visão ele fica e muda de emblema. Revalidar cobre os dois casos sem a
      // tela precisar saber em qual está.
      await mutate();
      if (seguinte) setSelecionado(seguinte.id);
    } catch (erro: any) {
      setAviso(erro.message);
    }
    setSalvando(null);
  }, [eventos, mutate, podeJulgar]);

  // Atalhos de teclado. Uma fila de quarenta alertas julgada no mouse é meia
  // hora; no teclado são minutos, e é a diferença entre a triagem acontecer
  // todo dia ou acumular até ninguém mais olhar.
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(alvo?.tagName)) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (indice < eventos.length - 1) setSelecionado(eventos[indice + 1].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (indice > 0) setSelecionado(eventos[indice - 1].id);
      } else if (atual && (e.key === '1' || e.key === 'c')) {
        e.preventDefault();
        julgar(atual, 'TRUE_POSITIVE');
      } else if (atual && (e.key === '2' || e.key === 'f')) {
        e.preventDefault();
        julgar(atual, 'FALSE_POSITIVE');
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [indice, eventos, atual, julgar]);

  const lojasVisiveis = sessao?.lojas ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Cabecalho
        Icone={ListChecks}
        titulo="Triagem de alertas"
        descricao="Assista ao clipe e diga se o alerta procedia. É essa classificação que mede a acurácia do sistema."
      />

      {resumo && (
        <div className="flex flex-wrap gap-4 mb-5 text-sm">
          <span className="text-slate-400">
            Pendentes <b className={`ml-1 tabular-nums ${resumo.pendentes ? 'text-amber-400' : 'text-emerald-400'}`}>{resumo.pendentes}</b>
          </span>
          <span className="text-slate-400">Confirmados <b className="ml-1 tabular-nums text-red-400">{resumo.confirmados}</b></span>
          <span className="text-slate-400">Falsos <b className="ml-1 tabular-nums text-slate-300">{resumo.falsos}</b></span>
          <span className="text-slate-400">Últimas 24h <b className="ml-1 tabular-nums text-slate-300">{resumo.ultimas_24h}</b></span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="flex flex-wrap gap-1.5">
          {FILTROS.map((f) => (
            <button
              key={f.id}
              onClick={() => { setFiltro(f.id); setPagina(0); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                filtro === f.id
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100'
              }`}
            >
              {f.rotulo}
            </button>
          ))}
        </div>
        {lojasVisiveis.length > 1 && (
          <div className="w-52">
            <Selecao value={loja} onChange={(e) => { setLoja(e.target.value); setPagina(0); }}>
              <option value="">Todas as lojas</option>
              {lojasVisiveis.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Selecao>
          </div>
        )}
        {podeJulgar && (
          <span className="hidden lg:flex items-center gap-1.5 text-[11px] text-slate-600 ml-auto">
            <Keyboard size={13} />
            <kbd className="px-1 bg-slate-900 border border-slate-800 rounded">J</kbd>
            <kbd className="px-1 bg-slate-900 border border-slate-800 rounded">K</kbd> navegar ·
            <kbd className="px-1 bg-slate-900 border border-slate-800 rounded">1</kbd> procedia ·
            <kbd className="px-1 bg-slate-900 border border-slate-800 rounded">2</kbd> falso
          </span>
        )}
      </div>

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}
      {isLoading && <Carregando linhas={5} />}

      {!isLoading && !error && eventos.length === 0 && (
        <Vazio
          Icone={filtro === 'pendentes' ? CheckCircle2 : ListChecks}
          titulo={filtro === 'pendentes' ? 'Fila em dia' : 'Nenhum evento neste recorte'}
          descricao={filtro === 'pendentes'
            ? 'Todos os alertas já foram classificados. Novos aparecem aqui automaticamente.'
            : 'Ajuste o filtro ou o período para ver outros eventos.'}
        />
      )}

      {eventos.length > 0 && (
        <div className="grid lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] gap-5 items-start">
          {/* Fila */}
          <div className="space-y-1.5 lg:max-h-[70vh] lg:overflow-y-auto lg:pr-1">
            {eventos.map((e) => {
              const v = VEREDICTO[e.verdict ?? ''] ?? { rotulo: e.verdict ?? '—', tom: 'neutro' as const };
              const ativo = e.id === selecionado;
              return (
                <button
                  key={e.id}
                  onClick={() => setSelecionado(e.id)}
                  className={`w-full text-left p-3 rounded-lg border transition ${
                    ativo
                      ? 'bg-slate-800 border-sky-700'
                      : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Emblema tom={v.tom}>{v.rotulo}</Emblema>
                    {e.human_feedback === 'TRUE_POSITIVE' && <Emblema tom="perigo">procedia</Emblema>}
                    {e.human_feedback === 'FALSE_POSITIVE' && <Emblema tom="neutro">falso</Emblema>}
                    {!e.human_feedback && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400" />}
                  </div>
                  <p className="text-sm text-slate-200 truncate">{e.store_name ?? `Loja ${e.store_id}`}</p>
                  <p className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                    <Clock size={11} />{faz(e.analyzed_at)}
                    {e.suspicion_score != null && (
                      <><Gauge size={11} />{Number(e.suspicion_score).toFixed(2)}</>
                    )}
                  </p>
                </button>
              );
            })}
            <Paginacao pagina={pagina} porPagina={POR_PAGINA} total={data?.total ?? 0} aoMudar={setPagina} />
          </div>

          {/* Detalhe */}
          {atual && (
            <Cartao className="p-4 lg:sticky lg:top-6">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-lg font-medium text-slate-100">
                    {atual.store_name ?? `Loja ${atual.store_id}`}
                  </h2>
                  <p className="text-xs text-slate-500 flex flex-wrap items-center gap-3 mt-1">
                    {atual.store_location && <span className="flex items-center gap-1"><MapPin size={12} />{atual.store_location}</span>}
                    <span className="flex items-center gap-1"><Clock size={12} />{quando(atual.analyzed_at)}</span>
                    <span className="font-mono">#{atual.id}</span>
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {(() => {
                    const v = VEREDICTO[atual.verdict ?? ''] ?? { rotulo: atual.verdict ?? 'sem veredicto', tom: 'neutro' as const };
                    return <Emblema tom={v.tom}><ShieldAlert size={11} />{v.rotulo}</Emblema>;
                  })()}
                  {atual.suspicion_score != null && (
                    <Emblema tom="neutro">score {Number(atual.suspicion_score).toFixed(2)}</Emblema>
                  )}
                </div>
              </div>

              {/* O clipe. Sem ele não há triagem possível: ninguém classifica
                  furto lendo um score. */}
              <div className="rounded-lg overflow-hidden bg-slate-950 border border-slate-800 mb-4">
                {atual.video_url ? (
                  <video
                    key={atual.id}
                    src={atual.video_url}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full max-h-[46vh] bg-black"
                  />
                ) : (
                  <div className="py-14 text-center">
                    <Film size={28} className="mx-auto mb-2 text-slate-700" />
                    <p className="text-xs text-slate-500">Clipe indisponível para este evento.</p>
                    <p className="text-[11px] text-slate-600 mt-1">
                      O dispositivo detectou, mas o vídeo não chegou ao armazenamento.
                    </p>
                  </div>
                )}
              </div>

              {atual.verdict_explanation && (
                <div className="mb-4">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">Análise automática</p>
                  <p className="text-sm text-slate-300 leading-relaxed bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                    {atual.verdict_explanation}
                  </p>
                </div>
              )}

              {podeJulgar ? (
                <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800">
                  {atual.human_feedback ? (
                    <>
                      <span className="text-sm text-slate-400">
                        Classificado como{' '}
                        <b className={atual.human_feedback === 'TRUE_POSITIVE' ? 'text-red-400' : 'text-slate-200'}>
                          {atual.human_feedback === 'TRUE_POSITIVE' ? 'furto confirmado' : 'falso alarme'}
                        </b>
                      </span>
                      <Botao
                        variante="fantasma" Icone={Undo2} className="ml-auto"
                        carregando={salvando === atual.id}
                        onClick={() => julgar(atual, null)}
                      >
                        Desfazer
                      </Botao>
                    </>
                  ) : (
                    <>
                      <Botao
                        variante="perigo" Icone={CheckCircle2}
                        carregando={salvando === atual.id}
                        onClick={() => julgar(atual, 'TRUE_POSITIVE')}
                      >
                        O alerta procedia
                      </Botao>
                      <Botao
                        variante="secundario" Icone={XCircle}
                        carregando={salvando === atual.id}
                        onClick={() => julgar(atual, 'FALSE_POSITIVE')}
                      >
                        Falso alarme
                      </Botao>
                      {indice < eventos.length - 1 && (
                        <span className="ml-auto text-[11px] text-slate-600 flex items-center gap-1">
                          próximo <ChevronRight size={12} />
                        </span>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500 pt-3 border-t border-slate-800">
                  Seu perfil permite visualizar os eventos, mas não classificá-los.
                </p>
              )}

              {atual.telemetry && (
                <details className="mt-4">
                  <summary className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-300">
                    Dados técnicos da detecção
                  </summary>
                  <pre className="mt-2 p-3 bg-slate-950 border border-slate-800 rounded-lg text-[11px] text-slate-400 overflow-x-auto">
                    {JSON.stringify(atual.telemetry, null, 2)}
                  </pre>
                </details>
              )}
            </Cartao>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * useSearchParams obriga a um limite de Suspense: sem ele o build falha ao
 * tentar pré-renderizar esta rota.
 */
export default function EventosPage() {
  return (
    <Suspense fallback={<div className="p-6 max-w-7xl mx-auto"><Carregando linhas={5} /></div>}>
      <Triagem />
    </Suspense>
  );
}
