"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { Building2, Plus, Link2, Copy, Check, PauseCircle, PlayCircle } from 'lucide-react';
import { Cabecalho, Cartao, Campo, Selecao, Botao, Emblema, Carregando, Erro, buscar, enviar, quando } from '../../../components/ui';
import { PLANOS } from '../../../lib/planos';

/**
 * Área do fornecedor. Criar cliente, mudar plano, suspender.
 *
 * Suspender não apaga nada: os dados continuam e o cliente deixa de receber
 * eventos novos. Apagar é uma decisão separada, com exportação antes.
 */

export default function PlataformaPage() {
  const { data, error, isLoading, mutate } = useSWR('/api/plataforma/organizacoes', buscar);
  const [criando, setCriando] = useState(false);
  const [form, setForm] = useState({ nome: '', slug: '', plano: 'trial', email_admin: '' });
  const [linkAdmin, setLinkAdmin] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const criar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      const r = await enviar('/api/plataforma/organizacoes', 'POST', form);
      setLinkAdmin(r.link_convite_admin);
      setCopiado(false);
      setCriando(false);
      setForm({ nome: '', slug: '', plano: 'trial', email_admin: '' });
      mutate();
    } catch (err: any) {
      setAviso(err.message);
    } finally {
      setSalvando(false);
    }
  };

  const alterar = async (id: number, mudanca: { plano?: string; status?: string }) => {
    setAviso(null);
    try {
      await enviar('/api/plataforma/organizacoes', 'PATCH', { id, ...mudanca });
      mutate();
    } catch (err: any) {
      setAviso(err.message);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Cabecalho
        Icone={Building2}
        titulo="Fornecedor"
        descricao="Clientes, planos e status. Suspender bloqueia a ingestão; os dados permanecem."
        acao={<Botao Icone={Plus} onClick={() => setCriando((v) => !v)}>Novo cliente</Botao>}
      />

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}

      {linkAdmin && (
        <Cartao className="p-5 mb-6 border-emerald-800/60 bg-emerald-950/20">
          <div className="flex items-center gap-2 mb-2"><Link2 size={16} className="text-emerald-400" />
            <p className="font-medium text-sm">Cliente criado. Convite do primeiro administrador:</p></div>
          <div className="flex gap-2">
            <code className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs break-all">{linkAdmin}</code>
            <Botao variante="secundario" Icone={copiado ? Check : Copy}
              onClick={async () => { await navigator.clipboard.writeText(linkAdmin); setCopiado(true); }}>
              {copiado ? 'Copiado' : 'Copiar'}
            </Botao>
          </div>
          <button onClick={() => setLinkAdmin(null)} className="text-xs text-slate-500 hover:text-slate-300 mt-3 underline">Fechar</button>
        </Cartao>
      )}

      {criando && (
        <Cartao className="p-4 mb-6">
          <form onSubmit={criar} className="grid gap-4 sm:grid-cols-2">
            <Campo autoFocus required rotulo="Nome do cliente" value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })} />
            <Campo required rotulo="Identificador (slug)" placeholder="rede-exemplo" value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
            <Selecao rotulo="Plano" value={form.plano} onChange={(e) => setForm({ ...form, plano: e.target.value })}>
              {Object.entries(PLANOS).map(([id, p]) => (
                <option key={id} value={id}>{p.rotulo} — {p.max_cameras} câmeras, {p.eventos_mes} eventos/mês</option>
              ))}
            </Selecao>
            <Campo type="email" required rotulo="E-mail do administrador" value={form.email_admin}
              onChange={(e) => setForm({ ...form, email_admin: e.target.value })} />
            <div className="sm:col-span-2 flex gap-2">
              <Botao type="submit" carregando={salvando}>Criar cliente</Botao>
              <Botao type="button" variante="fantasma" onClick={() => setCriando(false)}>Cancelar</Botao>
            </div>
          </form>
        </Cartao>
      )}

      {isLoading && <Carregando linhas={3} />}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}

      <div className="space-y-3">
        {data?.organizacoes.map((o: any) => {
          const suspensa = o.status !== 'ativa';
          return (
            <Cartao key={o.id} className={`p-4 ${suspensa ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-medium text-slate-100">{o.name}</h2>
                    <Emblema tom="info">{PLANOS[o.plan as keyof typeof PLANOS]?.rotulo ?? o.plan}</Emblema>
                    {suspensa && <Emblema tom="perigo">suspensa</Emblema>}
                  </div>
                  <p className="text-[11px] text-slate-500 font-mono">{o.slug} · criada {quando(o.created_at)}</p>
                </div>
                <div className="text-xs text-slate-400 flex gap-4 tabular-nums">
                  <span>{o.membros} membro(s)</span>
                  <span>{o.cameras} câmera(s)</span>
                  <span>{o.eventos_mes} evento(s) no mês</span>
                </div>
                <select value={o.plan} onChange={(e) => alterar(o.id, { plano: e.target.value })}
                  className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-300 outline-none focus:border-sky-500">
                  {Object.entries(PLANOS).map(([id, p]) => <option key={id} value={id}>{p.rotulo}</option>)}
                </select>
                <Botao variante="fantasma" className="!px-2"
                  title={suspensa ? 'Reativar' : 'Suspender (nenhum dado é apagado)'}
                  Icone={suspensa ? PlayCircle : PauseCircle}
                  onClick={() => alterar(o.id, { status: suspensa ? 'ativa' : 'suspensa' })}>{''}</Botao>
              </div>
            </Cartao>
          );
        })}
      </div>
    </div>
  );
}
