"use client"
import React, { useState } from 'react';
import useSWR, { mutate as mutateGlobal } from 'swr';
import { MapPin, Plus, Camera, Cpu, Copy, Check, Ban, KeyRound, AlertTriangle } from 'lucide-react';
import { Cabecalho, Cartao, Campo, Botao, Emblema, Carregando, Erro, Vazio, buscar, enviar, faz } from '../../../components/ui';
import { useApp } from '../../../components/contexto-app';

/**
 * Locais e agentes: onde a câmera está e qual equipamento a observa.
 *
 * A chave do agente aparece uma única vez, na criação. Depois só o prefixo é
 * mostrado. Quem perdeu a chave revoga e cria outra.
 */

const LIMITE_VISTO = 15 * 60 * 1000;

export default function LocaisPage() {
  const { filtroOrg, podeAdministrar, orgAtiva } = useApp();
  const chaveLocais = `/api/locais${filtroOrg ? `?${filtroOrg}` : ''}`;
  const { data, error, isLoading, mutate } = useSWR(chaveLocais, buscar);

  const [novoLocal, setNovoLocal] = useState(false);
  const [formLocal, setFormLocal] = useState({ nome: '', endereco: '' });
  const [agenteDe, setAgenteDe] = useState<number | null>(null);
  const [nomeAgente, setNomeAgente] = useState('');
  const [chaveCriada, setChaveCriada] = useState<{ chave: string; nome: string } | null>(null);
  const [copiada, setCopiada] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const criarLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      await enviar('/api/locais', 'POST', {
        nome: formLocal.nome.trim(),
        endereco: formLocal.endereco.trim() || null,
        organization_id: orgAtiva?.id,
      });
      setNovoLocal(false);
      setFormLocal({ nome: '', endereco: '' });
      mutate();
    } catch (err: any) {
      setAviso(err.message);
    } finally {
      setSalvando(false);
    }
  };

  const criarAgente = async (siteId: number) => {
    setSalvando(true);
    setAviso(null);
    try {
      const r = await enviar('/api/agentes', 'POST', { site_id: siteId, nome: nomeAgente.trim() });
      setChaveCriada({ chave: r.chave, nome: r.agente.name });
      setCopiada(false);
      setAgenteDe(null);
      setNomeAgente('');
      mutate();
    } catch (err: any) {
      setAviso(err.message);
    } finally {
      setSalvando(false);
    }
  };

  const revogar = async (id: number, nome: string) => {
    if (!confirm(`Revogar o agente "${nome}"? Ele deixa de enviar eventos imediatamente.`)) return;
    try {
      await enviar(`/api/agentes?id=${id}`, 'DELETE');
      mutate();
    } catch (err: any) {
      setAviso(err.message);
    }
  };

  const copiar = async () => {
    if (!chaveCriada) return;
    await navigator.clipboard.writeText(chaveCriada.chave);
    setCopiada(true);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Cabecalho
        Icone={MapPin}
        titulo="Locais e agentes"
        descricao="Cada local tem câmeras e os agentes que as observam."
        acao={podeAdministrar && <Botao Icone={Plus} onClick={() => setNovoLocal((v) => !v)}>Novo local</Botao>}
      />

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}

      {chaveCriada && (
        <Cartao className="p-5 mb-6 border-emerald-800/60 bg-emerald-950/20">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound size={16} className="text-emerald-400" />
            <p className="font-medium text-sm">Chave do agente "{chaveCriada.nome}"</p>
          </div>
          <p className="text-xs text-amber-300 mb-3">
            Copie agora. Por segurança ela não será mostrada de novo. Se perder, revogue este agente e crie outro.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs break-all text-slate-200">
              {chaveCriada.chave}
            </code>
            <Botao variante="secundario" Icone={copiada ? Check : Copy} onClick={copiar}>
              {copiada ? 'Copiada' : 'Copiar'}
            </Botao>
          </div>
          <button onClick={() => setChaveCriada(null)} className="text-xs text-slate-500 hover:text-slate-300 mt-3 underline">
            Já copiei, fechar
          </button>
        </Cartao>
      )}

      {novoLocal && (
        <Cartao className="p-4 mb-6">
          <form onSubmit={criarLocal} className="grid gap-4 sm:grid-cols-2">
            <Campo autoFocus required rotulo="Nome do local" placeholder="Loja Centro"
              value={formLocal.nome} onChange={(e) => setFormLocal({ ...formLocal, nome: e.target.value })} />
            <Campo rotulo="Endereço (opcional)" value={formLocal.endereco}
              onChange={(e) => setFormLocal({ ...formLocal, endereco: e.target.value })} />
            <div className="sm:col-span-2 flex gap-2">
              <Botao type="submit" carregando={salvando} disabled={!formLocal.nome.trim()}>Criar local</Botao>
              <Botao type="button" variante="fantasma" onClick={() => setNovoLocal(false)}>Cancelar</Botao>
            </div>
          </form>
        </Cartao>
      )}

      {isLoading && <Carregando linhas={3} />}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}
      {data && data.locais.length === 0 && (
        <Vazio Icone={MapPin} titulo="Nenhum local cadastrado"
          descricao="Crie um local para depois instalar o agente e ligar as câmeras." />
      )}

      <div className="space-y-4">
        {data?.locais.map((local: any) => (
          <Cartao key={local.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
              <div>
                <h2 className="font-medium text-slate-100">{local.name}</h2>
                <p className="text-xs text-slate-500">{local.address ?? 'sem endereço'} · {local.organizacao}</p>
              </div>
              {podeAdministrar && (
                <Botao variante="secundario" Icone={Cpu} onClick={() => setAgenteDe(agenteDe === local.id ? null : local.id)}>
                  Novo agente
                </Botao>
              )}
            </div>

            {agenteDe === local.id && (
              <div className="flex flex-wrap gap-2 mb-4 p-3 bg-slate-950/60 border border-slate-800 rounded-lg">
                <div className="flex-1 min-w-[200px]">
                  <Campo autoFocus placeholder="Ex.: Agente caixa 1" value={nomeAgente}
                    onChange={(e) => setNomeAgente(e.target.value)} />
                </div>
                <Botao carregando={salvando} disabled={!nomeAgente.trim()} onClick={() => criarAgente(local.id)}>
                  Gerar chave
                </Botao>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2 flex items-center gap-1.5">
                  <Camera size={11} />Câmeras ({local.cameras.length})
                </p>
                {local.cameras.length === 0 ? (
                  <p className="text-xs text-slate-600">Nenhuma câmera ainda. Elas aparecem quando o agente envia o primeiro evento.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {local.cameras.map((c: any) => (
                      <li key={c.id} className="flex items-center gap-2 text-sm">
                        <span className={`w-1.5 h-1.5 rounded-full ${c.last_event_at && Date.now() - new Date(c.last_event_at).getTime() < LIMITE_VISTO ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                        <span className="text-slate-200">{c.name}</span>
                        <span className="ml-auto text-[11px] text-slate-500">{c.last_event_at ? `último evento ${faz(c.last_event_at)}` : 'sem eventos'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-2 flex items-center gap-1.5">
                  <Cpu size={11} />Agentes ({local.agentes.length})
                </p>
                {local.agentes.length === 0 ? (
                  <p className="text-xs text-slate-600">Nenhum agente instalado neste local.</p>
                ) : (
                  <ul className="space-y-2">
                    {local.agentes.map((a: any) => {
                      const revogado = !!a.revoked_at;
                      const visto = a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() < LIMITE_VISTO;
                      return (
                        <li key={a.id} className={`flex items-center gap-2 text-sm ${revogado ? 'opacity-50' : ''}`}>
                          <span className="text-slate-200">{a.name}</span>
                          <code className="text-[11px] text-slate-500">{a.key_prefix}…</code>
                          {revogado ? <Emblema tom="perigo">revogado</Emblema>
                            : visto ? <Emblema tom="sucesso">online</Emblema>
                            : <Emblema tom="aviso">sem sinal {a.last_seen_at ? faz(a.last_seen_at) : ''}</Emblema>}
                          {podeAdministrar && !revogado && (
                            <button onClick={() => revogar(a.id, a.name)} title="Revogar"
                              className="ml-auto text-slate-600 hover:text-red-400"><Ban size={14} /></button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {local.agentes.length > 0 && local.agentes.every((a: any) => !a.revoked_at && !(a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() < LIMITE_VISTO)) && (
                  <p className="flex items-center gap-1.5 text-[11px] text-amber-300 mt-3">
                    <AlertTriangle size={12} />Nenhum agente deste local comunicou nos últimos 15 minutos.
                  </p>
                )}
              </div>
            </div>
          </Cartao>
        ))}
      </div>
    </div>
  );
}
