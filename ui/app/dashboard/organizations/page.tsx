"use client"
import React, { useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  Building2, Plus, Store as StoreIcon, HardDrive, Users, Activity,
  AlertTriangle, PauseCircle, PlayCircle, TrendingUp,
} from 'lucide-react';
import {
  Botao, Campo, Selecao, Busca, Cartao, Cabecalho, Emblema,
  Carregando, Vazio, Erro, Medidor, Paginacao, Indicador, buscar, enviar,
} from '../../../components/ui';
import { PLANOS } from '../../api/planos';

/**
 * Clientes — a lista de inquilinos.
 *
 * Reescrita sobre as primitivas compartilhadas. A versão anterior reinventava
 * botão, campo e estado vazio dentro da própria página; era funcional e
 * divergia de todas as outras telas.
 *
 * O que a tela responde, além de "quais clientes existem":
 *   - quem está perto do teto do plano (conversa de upgrade)
 *   - quem tem appliance instalado e parou de detectar (conversa de retenção)
 *
 * Os dois são acionáveis. O total de eventos, sozinho, não é.
 */

const POR_PAGINA = 10;

const TOM_PLANO: Record<string, 'neutro' | 'info' | 'sucesso' | 'aviso'> = {
  trial: 'neutro',
  legado: 'aviso',
  essencial: 'info',
  profissional: 'info',
  enterprise: 'sucesso',
};

interface Org {
  id: number;
  name: string;
  slug: string;
  plan: string;
  status: string;
  max_stores: number;
  max_appliances: number;
  store_count: number;
  appliance_count: number;
  member_count: number;
  eventos_24h: number;
}

/** Appliance instalado e nenhum evento em 24h: pagando por algo que parou. */
function estaParado(org: Org): boolean {
  return org.status === 'ativa' && org.appliance_count > 0 && org.eventos_24h === 0;
}

/** A 80% do teto em qualquer recurso. Avisar depois de estourar é tarde. */
function estaNoLimite(org: Org): boolean {
  return (
    org.store_count / Math.max(org.max_stores, 1) >= 0.8 ||
    org.appliance_count / Math.max(org.max_appliances, 1) >= 0.8
  );
}

export default function OrganizationsPage() {
  const { data, error, mutate, isLoading } = useSWR<Org[]>('/api/organizations', buscar);

  const [criando, setCriando] = useState(false);
  const [form, setForm] = useState({ name: '', plan: 'trial' });
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [termo, setTermo] = useState('');
  const [pagina, setPagina] = useState(0);

  const orgs = data ?? [];

  const filtradas = useMemo(() => {
    const t = termo.trim().toLowerCase();
    if (!t) return orgs;
    return orgs.filter((o) => o.name.toLowerCase().includes(t) || o.slug.includes(t));
  }, [orgs, termo]);

  const visiveis = filtradas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);

  const resumo = useMemo(() => ({
    total: orgs.length,
    ativas: orgs.filter((o) => o.status === 'ativa').length,
    paradas: orgs.filter(estaParado).length,
    noLimite: orgs.filter((o) => o.status === 'ativa' && estaNoLimite(o)).length,
  }), [orgs]);

  const criar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      await enviar('/api/organizations', 'POST', form);
      setCriando(false);
      setForm({ name: '', plan: 'trial' });
      mutate();
    } catch (erro: any) {
      setAviso(erro.message);
    }
    setSalvando(false);
  };

  const alterar = async (id: number, mudanca: { plan?: string; status?: string }) => {
    setAviso(null);
    // Atualização otimista: a lista responde na hora e reverte se a API negar.
    // Sem isto, trocar um plano parecia que o clique não funcionou.
    mutate(
      (atual) => atual?.map((o) => (o.id === id ? { ...o, ...mudanca } : o)),
      { revalidate: false },
    );
    try {
      await enviar('/api/organizations', 'PUT', { id, ...mudanca });
    } catch (erro: any) {
      setAviso(erro.message);
    }
    mutate();
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Cabecalho
        Icone={Building2}
        titulo="Clientes"
        descricao="Cada cliente é uma organização, com suas lojas, sua equipe e seu plano."
        acao={<Botao Icone={Plus} onClick={() => setCriando((v) => !v)}>Novo cliente</Botao>}
      />

      {orgs.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <Indicador rotulo="Clientes" valor={resumo.total} Icone={Building2} />
          <Indicador rotulo="Ativos" valor={resumo.ativas} Icone={Activity} tom="sucesso" />
          <Indicador
            rotulo="Sem detectar" valor={resumo.paradas} Icone={AlertTriangle}
            tom={resumo.paradas ? 'perigo' : 'neutro'}
            nota={resumo.paradas ? 'appliance no ar, zero eventos em 24h' : undefined}
          />
          <Indicador
            rotulo="Perto do teto" valor={resumo.noLimite} Icone={TrendingUp}
            tom={resumo.noLimite ? 'aviso' : 'neutro'}
            nota={resumo.noLimite ? 'candidatos a upgrade' : undefined}
          />
        </div>
      )}

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}

      {criando && (
        <Cartao className="p-4 mb-6">
          <form onSubmit={criar}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo
                autoFocus rotulo="Nome do cliente" placeholder="Rede Exemplo Ltda"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Selecao
                rotulo="Plano" value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value })}
              >
                {Object.entries(PLANOS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.rotulo} — {p.max_stores} loja(s), {p.max_appliances} appliance(s)
                  </option>
                ))}
              </Selecao>
            </div>
            <div className="flex gap-2 mt-4">
              <Botao type="submit" carregando={salvando} disabled={!form.name.trim()}>
                Cadastrar
              </Botao>
              <Botao type="button" variante="fantasma" onClick={() => setCriando(false)}>
                Cancelar
              </Botao>
            </div>
          </form>
        </Cartao>
      )}

      {orgs.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <Busca valor={termo} aoMudar={(v) => { setTermo(v); setPagina(0); }} placeholder="Buscar cliente…" />
        </div>
      )}

      {isLoading && <Carregando linhas={4} />}

      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}

      {!isLoading && !error && orgs.length === 0 && (
        <Vazio
          Icone={Building2}
          titulo="Nenhum cliente cadastrado"
          descricao="Cadastre o primeiro cliente para começar a provisionar lojas e appliances."
          acao={<Botao Icone={Plus} onClick={() => setCriando(true)}>Novo cliente</Botao>}
        />
      )}

      {!isLoading && !error && orgs.length > 0 && filtradas.length === 0 && (
        <Vazio titulo="Nenhum cliente corresponde à busca" descricao={`Sem resultados para “${termo}”.`} />
      )}

      <div className="space-y-3">
        {visiveis.map((org) => {
          const suspensa = org.status !== 'ativa';
          const parado = estaParado(org);

          return (
            <Cartao
              key={org.id}
              className={`p-4 transition ${suspensa ? 'opacity-55' : 'hover:border-slate-700'}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-medium text-slate-100 truncate">{org.name}</h2>
                    <Emblema tom={TOM_PLANO[org.plan] ?? 'neutro'}>{org.plan}</Emblema>
                    {suspensa && <Emblema tom="perigo">{org.status}</Emblema>}
                    {parado && (
                      <Emblema tom="aviso">
                        <AlertTriangle size={11} /> sem detecção 24h
                      </Emblema>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">{org.slug}</p>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={org.plan}
                    onChange={(e) => alterar(org.id, { plan: e.target.value })}
                    className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-xs text-slate-300 outline-none focus:border-sky-500"
                  >
                    {Object.entries(PLANOS).map(([id, p]) => (
                      <option key={id} value={id}>{p.rotulo}</option>
                    ))}
                    {!(org.plan in PLANOS) && <option value={org.plan}>{org.plan}</option>}
                  </select>
                  <Botao
                    variante="fantasma"
                    className="!px-2"
                    title={suspensa ? 'Reativar' : 'Suspender — nenhum dado é apagado'}
                    onClick={() => alterar(org.id, { status: suspensa ? 'ativa' : 'suspensa' })}
                    Icone={suspensa ? PlayCircle : PauseCircle}
                  >{''}</Botao>
                </div>
              </div>

              <div className="flex flex-wrap gap-5">
                <Medidor atual={org.store_count} limite={org.max_stores} rotulo="Lojas" Icone={StoreIcon} />
                <Medidor atual={org.appliance_count} limite={org.max_appliances} rotulo="Appliances" Icone={HardDrive} />
                <div className="flex-1 min-w-[130px] space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <Users size={13} /><span>Equipe</span>
                    <span className="ml-auto font-mono tabular-nums text-slate-300">{org.member_count}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <Activity size={13} /><span>Eventos 24h</span>
                    <span className={`ml-auto font-mono tabular-nums ${parado ? 'text-amber-400' : 'text-slate-300'}`}>
                      {org.eventos_24h}
                    </span>
                  </div>
                </div>
              </div>
            </Cartao>
          );
        })}
      </div>

      <Paginacao pagina={pagina} porPagina={POR_PAGINA} total={filtradas.length} aoMudar={setPagina} />
    </div>
  );
}
