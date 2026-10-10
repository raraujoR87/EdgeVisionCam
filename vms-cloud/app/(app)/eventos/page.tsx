"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { ListChecks, Clock, Undo2, CheckCircle2, XCircle, Camera, Tag, AlertTriangle } from 'lucide-react';
import { Cabecalho, Cartao, Emblema, Carregando, Erro, Vazio, Botao, Selecao, Paginacao, buscar, enviar, quando, faz } from '../../../components/ui';
import { useApp } from '../../../components/contexto-app';

/**
 * Eventos: a fila onde a equipe confirma ou descarta cada alerta da IA.
 *
 * Não há vídeo aqui, por decisão de produto: a nuvem guarda só o veredito, o
 * resumo e os metadados. Quem revisa vê o que a IA registrou e decide. A
 * revisão alimenta a taxa de acerto do painel.
 */

const POR_PAGINA = 20;

const VEREDITO: Record<string, { rotulo: string; tom: 'perigo' | 'sucesso' | 'neutro' | 'aviso' }> = {
  SUSPEITO: { rotulo: 'Suspeito', tom: 'perigo' },
  SEM_INDICIO: { rotulo: 'Sem indício', tom: 'sucesso' },
  INCONCLUSIVO: { rotulo: 'Inconclusivo', tom: 'neutro' },
};

const FILTROS = [
  { id: 'todos', rotulo: 'Todos' },
  { id: 'pendente', rotulo: 'Aguardando revisão' },
  { id: 'procede', rotulo: 'Procediam' },
  { id: 'falso', rotulo: 'Falsos alarmes' },
];

interface Evento {
  id: number;
  occurred_at: string;
  status: string;
  verdict: string | null;
  confidence: string | number | null;
  summary: string | null;
  labels: string[];
  error: string | null;
  human_verdict: string | null;
  reviewed_at: string | null;
  camera: string | null;
  local: string;
  metadata: Record<string, unknown> | null;
}

export default function EventosPage() {
  const { filtroOrg, podeRevisar } = useApp();
  const [revisao, setRevisao] = useState('pendente');
  const [veredicto, setVeredicto] = useState('');
  const [pagina, setPagina] = useState(0);
  const [salvando, setSalvando] = useState<number | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const url = `/api/eventos?revisao=${revisao}&limit=${POR_PAGINA}&offset=${pagina * POR_PAGINA}` +
    (veredicto ? `&veredicto=${veredicto}` : '') + (filtroOrg ? `&${filtroOrg}` : '');
  const { data, error, isLoading, mutate } = useSWR(url, buscar, { refreshInterval: 30_000 });

  const revisar = async (evento: Evento, valor: 'PROCEDE' | 'FALSO_ALARME' | null) => {
    setSalvando(evento.id);
    setAviso(null);
    try {
      await enviar(`/api/eventos/${evento.id}`, 'PATCH', { revisao: valor });
      await mutate();
    } catch (e: any) {
      setAviso(e.message);
    } finally {
      setSalvando(null);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Cabecalho
        Icone={ListChecks}
        titulo="Eventos"
        descricao="O que a IA registrou. Confirme se o alerta procedia ou descarte o falso alarme."
      />

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex flex-wrap gap-1.5">
          {FILTROS.map((f) => (
            <button key={f.id} onClick={() => { setRevisao(f.id); setPagina(0); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                revisao === f.id ? 'bg-sky-600 text-white' : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100'
              }`}>{f.rotulo}</button>
          ))}
        </div>
        <div className="w-48">
          <Selecao value={veredicto} onChange={(e) => { setVeredicto(e.target.value); setPagina(0); }}>
            <option value="">Qualquer veredito</option>
            <option value="SUSPEITO">Suspeito</option>
            <option value="SEM_INDICIO">Sem indício</option>
            <option value="INCONCLUSIVO">Inconclusivo</option>
          </Selecao>
        </div>
      </div>

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}
      {isLoading && <Carregando linhas={4} />}

      {data && data.eventos.length === 0 && (
        <Vazio
          Icone={revisao === 'pendente' ? CheckCircle2 : ListChecks}
          titulo={revisao === 'pendente' ? 'Nenhum alerta aguardando revisão' : 'Nenhum evento neste filtro'}
          descricao={revisao === 'pendente' ? 'Tudo que a IA marcou já foi revisado.' : 'Ajuste os filtros para ver outros eventos.'}
        />
      )}

      <div className="space-y-2.5">
        {data?.eventos.map((e: Evento) => {
          const v = VEREDITO[e.verdict ?? ''] ?? { rotulo: e.status === 'FALHOU' ? 'Falhou' : 'Em análise', tom: 'aviso' as const };
          const confianca = e.confidence != null ? Math.round(Number(e.confidence) * 100) : null;
          return (
            <Cartao key={e.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Emblema tom={v.tom}>{v.rotulo}</Emblema>
                {confianca != null && <Emblema tom="neutro">confiança {confianca}%</Emblema>}
                {e.human_verdict === 'PROCEDE' && <Emblema tom="perigo">procedeu</Emblema>}
                {e.human_verdict === 'FALSO_ALARME' && <Emblema tom="neutro">falso alarme</Emblema>}
                <span className="ml-auto text-[11px] text-slate-500 flex items-center gap-1">
                  <Clock size={11} />{quando(e.occurred_at)} · {faz(e.occurred_at)}
                </span>
              </div>

              <p className="text-sm text-slate-200 leading-relaxed">
                {e.summary ?? (e.status === 'FALHOU' ? 'A análise não foi concluída.' : 'Aguardando análise da IA.')}
              </p>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
                <span className="flex items-center gap-1"><Camera size={11} />{e.camera ?? 'câmera'} · {e.local}</span>
                {e.labels.length > 0 && (
                  <span className="flex items-center gap-1 flex-wrap"><Tag size={11} />
                    {e.labels.map((l) => <span key={l} className="px-1.5 py-px bg-slate-800 rounded">{l}</span>)}
                  </span>
                )}
              </div>

              {e.status === 'FALHOU' && (
                <p className="flex items-center gap-1.5 text-[11px] text-amber-300 mt-2">
                  <AlertTriangle size={12} />Motivo: {e.error}
                </p>
              )}

              {podeRevisar && e.status === 'ANALISADO' && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-slate-800">
                  {e.human_verdict ? (
                    <>
                      <span className="text-xs text-slate-400 self-center">
                        Revisado em {quando(e.reviewed_at)}
                      </span>
                      <Botao variante="fantasma" Icone={Undo2} className="ml-auto"
                        carregando={salvando === e.id} onClick={() => revisar(e, null)}>Desfazer</Botao>
                    </>
                  ) : (
                    <>
                      <Botao variante="perigo" Icone={CheckCircle2} carregando={salvando === e.id}
                        onClick={() => revisar(e, 'PROCEDE')}>O alerta procede</Botao>
                      <Botao variante="secundario" Icone={XCircle} carregando={salvando === e.id}
                        onClick={() => revisar(e, 'FALSO_ALARME')}>Falso alarme</Botao>
                    </>
                  )}
                </div>
              )}
            </Cartao>
          );
        })}
      </div>

      {data && <Paginacao pagina={pagina} porPagina={POR_PAGINA} total={data.total} aoMudar={setPagina} />}
    </div>
  );
}
