"use client"
import React from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  LayoutDashboard, ListChecks, ShieldAlert, CheckCircle2, XCircle,
  Store as StoreIcon, WifiOff, Radio, AlertTriangle, ArrowRight, Activity,
} from 'lucide-react';
import {
  Cartao, Cabecalho, Indicador, Emblema, Carregando, Erro, Vazio, Barras, Botao, buscar, faz,
} from '../../components/ui';
import { useConsole } from './contexto';

/**
 * Painel do cliente.
 *
 * Responde duas perguntas, nessa ordem: **tem trabalho para mim?** e
 * **o sistema está funcionando?**
 *
 * A segunda é a que costuma faltar. Um antifurto que parou de detectar produz
 * uma tela idêntica à de uma loja tranquila: zero alertas. Sem a saúde dos
 * dispositivos aqui em cima, o cliente descobre que o produto estava mudo
 * quando alguém pergunta pelo vídeo do furto da semana passada.
 */

const ROTULO_ALERTA: Record<string, { texto: string; tom: 'perigo' | 'aviso' | 'neutro'; Icone: any }> = {
  offline: { texto: 'Fora do ar', tom: 'perigo', Icone: WifiOff },
  sem_deteccao: { texto: 'Sem detecção', tom: 'aviso', Icone: AlertTriangle },
  sem_dispositivo: { texto: 'Sem dispositivo', tom: 'neutro', Icone: StoreIcon },
};

export default function PainelPage() {
  const { filtroOrg, orgAtiva } = useConsole();
  const { data, error, isLoading, mutate } = useSWR(
    `/api/console/resumo${filtroOrg ? `?${filtroOrg}` : ''}`,
    buscar,
    // A triagem é feita a várias mãos. Sem revalidação, dois fiscais olham o
    // mesmo alerta pendente que o outro já resolveu.
    { refreshInterval: 60_000 },
  );

  if (isLoading) {
    return <div className="p-6 max-w-6xl mx-auto"><Carregando linhas={5} /></div>;
  }
  if (error) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />
      </div>
    );
  }

  const fila = data.fila;
  const alertas = data.alertas as { tipo: string; loja: string; detalhe: string }[];
  const lojas = data.lojas as any[];
  const serie = (data.serie as any[]).map((d) => ({
    rotulo: d.dia, valor: d.total, destaque: d.confirmados,
  }));

  const semDados = fila.total === 0 && lojas.length === 0;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Cabecalho
        Icone={LayoutDashboard}
        titulo={orgAtiva ? orgAtiva.name : 'Painel'}
        descricao="O que precisa da sua atenção agora, e como estão os dispositivos nas lojas."
        acao={
          fila.pendentes > 0 ? (
            <Link href="/console/eventos?pendentes=1">
              <Botao Icone={ListChecks}>Triar {fila.pendentes} pendente{fila.pendentes > 1 ? 's' : ''}</Botao>
            </Link>
          ) : undefined
        }
      />

      {semDados && (
        <Vazio
          Icone={StoreIcon}
          titulo="Nenhuma loja configurada ainda"
          descricao="Assim que o técnico instalar o primeiro dispositivo, os eventos aparecem aqui automaticamente."
        />
      )}

      {!semDados && (
        <>
          {/* Saúde primeiro. Um alerta de dispositivo fora do ar vale mais que
              qualquer número abaixo dele — sem o dispositivo, os números param
              de existir sem avisar. */}
          {alertas.length > 0 && (
            <Cartao className="p-4 mb-5 border-amber-900/50 bg-amber-950/10">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={16} className="text-amber-400" />
                <h2 className="text-sm font-medium text-amber-200">
                  {alertas.length} ponto{alertas.length > 1 ? 's' : ''} de atenção
                </h2>
              </div>
              <ul className="space-y-2">
                {alertas.map((a, i) => {
                  const r = ROTULO_ALERTA[a.tipo] ?? ROTULO_ALERTA.sem_dispositivo;
                  return (
                    <li key={i} className="flex items-start gap-2.5 text-sm">
                      <r.Icone size={15} className="mt-0.5 shrink-0 text-slate-500" />
                      <div className="min-w-0">
                        <span className="text-slate-200">{a.loja}</span>
                        <Emblema tom={r.tom}>{r.texto}</Emblema>
                        <p className="text-xs text-slate-500 mt-0.5">{a.detalhe}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Cartao>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <Indicador
              rotulo="Aguardando triagem" valor={fila.pendentes} Icone={ListChecks}
              tom={fila.pendentes > 0 ? 'aviso' : 'sucesso'}
              nota={fila.pendentes_suspeitos > 0 ? `${fila.pendentes_suspeitos} marcados como suspeitos` : 'fila em dia'}
            />
            <Indicador
              rotulo="Eventos em 24h" valor={fila.eventos_24h} Icone={Activity}
              nota={fila.suspeitos_24h > 0 ? `${fila.suspeitos_24h} suspeitos` : undefined}
            />
            <Indicador
              rotulo="Furtos confirmados" valor={fila.confirmados} Icone={ShieldAlert}
              tom={fila.confirmados > 0 ? 'perigo' : 'neutro'} nota="no histórico completo"
            />
            <Indicador
              rotulo="Último evento"
              valor={<span className="text-lg">{faz(fila.ultimo_evento)}</span>}
              Icone={Radio}
            />
          </div>

          <div className="grid lg:grid-cols-5 gap-5">
            <Cartao className="p-4 lg:col-span-3">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-medium text-slate-200">Eventos por dia</h2>
                <span className="text-[11px] text-slate-500">
                  últimos {serie.length} dias · <span className="text-red-400">vermelho</span> = confirmados
                </span>
              </div>
              <Barras
                dados={serie}
                formatarRotulo={(d) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
              />
              <div className="flex justify-between text-[10px] text-slate-600 mt-2">
                <span>{new Date(serie[0]?.rotulo).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                <span>hoje</span>
              </div>
            </Cartao>

            <Cartao className="p-4 lg:col-span-2">
              <h2 className="text-sm font-medium text-slate-200 mb-3">Suas lojas</h2>
              <div className="space-y-2.5">
                {lojas.map((l) => {
                  const online = l.appliances > 0 && l.appliances_online > 0;
                  return (
                    <Link
                      key={l.id}
                      href={`/console/eventos?store_id=${l.id}`}
                      className="flex items-center gap-3 p-2.5 -mx-1 rounded-lg hover:bg-slate-800/60 transition group"
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        l.appliances === 0 ? 'bg-slate-600'
                          : online ? 'bg-emerald-500' : 'bg-red-500'
                      }`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-200 truncate">{l.name}</p>
                        <p className="text-[11px] text-slate-500">
                          {l.appliances === 0
                            ? 'sem dispositivo'
                            : online
                              ? `${l.eventos_24h} evento(s) em 24h`
                              : `sem sinal ${faz(l.visto_por_ultimo)}`}
                        </p>
                      </div>
                      {l.pendentes > 0 && (
                        <span className="text-xs font-mono tabular-nums text-amber-400 shrink-0">
                          {l.pendentes}
                        </span>
                      )}
                      <ArrowRight size={14} className="text-slate-700 group-hover:text-slate-400 shrink-0" />
                    </Link>
                  );
                })}
              </div>
            </Cartao>
          </div>

          {fila.confirmados + fila.falsos > 0 && (
            <div className="grid grid-cols-2 gap-3 mt-5">
              <Cartao className="p-4 flex items-center gap-3">
                <CheckCircle2 size={20} className="text-red-400 shrink-0" />
                <div>
                  <p className="text-xs text-slate-400">Alertas que procediam</p>
                  <p className="text-lg font-semibold tabular-nums">{fila.confirmados}</p>
                </div>
              </Cartao>
              <Cartao className="p-4 flex items-center gap-3">
                <XCircle size={20} className="text-slate-500 shrink-0" />
                <div>
                  <p className="text-xs text-slate-400">Falsos alarmes</p>
                  <p className="text-lg font-semibold tabular-nums">{fila.falsos}</p>
                </div>
              </Cartao>
            </div>
          )}
        </>
      )}
    </div>
  );
}
