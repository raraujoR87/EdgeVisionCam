"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { Users, UserPlus, Trash2, Link2, Copy, Check, XCircle } from 'lucide-react';
import { Cabecalho, Cartao, Campo, Selecao, Botao, Emblema, Carregando, Erro, Vazio, buscar, enviar, quando } from '../../../components/ui';
import { useApp } from '../../../components/contexto-app';

/**
 * Equipe e convites. O convite tem link de uso único, válido por 72 horas.
 * Quem define a senha é a própria pessoa, pelo link. O administrador nunca
 * conhece a senha de ninguém.
 */

const PAPEIS = [
  { id: 'ADMIN', rotulo: 'Administrador', desc: 'Gerencia equipe e locais, revisa eventos e vê a auditoria.' },
  { id: 'OPERADOR', rotulo: 'Operador', desc: 'Revisa eventos (confirma ou descarta alertas).' },
  { id: 'VISUALIZADOR', rotulo: 'Visualizador', desc: 'Acompanha painel, eventos e relatórios. Não revisa.' },
];

const TOM: Record<string, 'sucesso' | 'info' | 'neutro'> = { ADMIN: 'sucesso', OPERADOR: 'info', VISUALIZADOR: 'neutro' };

export default function EquipePage() {
  const { filtroOrg, orgAtiva, podeAdministrar } = useApp();
  const { data, error, isLoading, mutate } = useSWR(`/api/equipe${filtroOrg ? `?${filtroOrg}` : ''}`, buscar);
  const convites = useSWR(`/api/convites`, buscar);

  const [convidando, setConvidando] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'OPERADOR' });
  const [linkCriado, setLinkCriado] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const convidar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      const r = await enviar('/api/convites', 'POST', {
        email: form.email.trim(), role: form.role, organization_id: orgAtiva?.id,
      });
      setLinkCriado(r.link);
      setCopiado(false);
      setForm({ email: '', role: 'OPERADOR' });
      setConvidando(false);
      convites.mutate();
    } catch (err: any) {
      setAviso(err.message);
    } finally {
      setSalvando(false);
    }
  };

  const mudarPapel = async (membro: any, role: string) => {
    setAviso(null);
    try {
      await enviar('/api/equipe', 'PATCH', { membership_id: membro.membership_id, role });
      mutate();
    } catch (err: any) {
      setAviso(err.message);
      mutate();
    }
  };

  const remover = async (membro: any) => {
    if (!confirm(`Remover ${membro.email} desta organização? A conta continua existindo, mas perde o acesso a estes dados.`)) return;
    try {
      await enviar(`/api/equipe?membership_id=${membro.membership_id}`, 'DELETE');
      mutate();
    } catch (err: any) {
      setAviso(err.message);
    }
  };

  const cancelarConvite = async (id: number) => {
    try {
      await enviar(`/api/convites?id=${id}`, 'DELETE');
      convites.mutate();
    } catch (err: any) {
      setAviso(err.message);
    }
  };

  if (!podeAdministrar) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Vazio Icone={Users} titulo="Restrito aos administradores"
          descricao="Peça a um administrador da sua organização para alterar a equipe." />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Cabecalho
        Icone={Users}
        titulo="Equipe"
        descricao={orgAtiva ? `Quem acessa os dados de ${orgAtiva.nome}, e com que papel.` : 'Quem tem acesso e com que papel.'}
        acao={<Botao Icone={UserPlus} onClick={() => setConvidando((v) => !v)}>Convidar pessoa</Botao>}
      />

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}

      {linkCriado && (
        <Cartao className="p-5 mb-6 border-emerald-800/60 bg-emerald-950/20">
          <div className="flex items-center gap-2 mb-2">
            <Link2 size={16} className="text-emerald-400" />
            <p className="font-medium text-sm">Convite criado</p>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Envie este link para a pessoa por um canal de confiança. Ele vale 72 horas e funciona uma vez.
            Não enviamos e-mail automaticamente.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs break-all">{linkCriado}</code>
            <Botao variante="secundario" Icone={copiado ? Check : Copy}
              onClick={async () => { await navigator.clipboard.writeText(linkCriado); setCopiado(true); }}>
              {copiado ? 'Copiado' : 'Copiar'}
            </Botao>
          </div>
          <button onClick={() => setLinkCriado(null)} className="text-xs text-slate-500 hover:text-slate-300 mt-3 underline">Fechar</button>
        </Cartao>
      )}

      {convidando && (
        <Cartao className="p-4 mb-6">
          <form onSubmit={convidar} className="grid gap-4 sm:grid-cols-2">
            <Campo autoFocus type="email" required rotulo="E-mail" placeholder="pessoa@empresa.com.br"
              value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Selecao rotulo="Papel" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {PAPEIS.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
            </Selecao>
            <p className="sm:col-span-2 text-xs text-slate-500">{PAPEIS.find((p) => p.id === form.role)?.desc}</p>
            <div className="sm:col-span-2 flex gap-2">
              <Botao type="submit" carregando={salvando} disabled={!form.email.trim()}>Gerar convite</Botao>
              <Botao type="button" variante="fantasma" onClick={() => setConvidando(false)}>Cancelar</Botao>
            </div>
          </form>
        </Cartao>
      )}

      {(isLoading) && <Carregando linhas={3} />}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}

      <div className="space-y-2">
        {data?.membros.map((m: any) => (
          <Cartao key={m.membership_id} className="p-3.5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-100 truncate">{m.email}</p>
                <p className="text-[11px] text-slate-500">{m.organizacao} · desde {quando(m.created_at)}</p>
              </div>
              <Emblema tom={TOM[m.role] ?? 'neutro'}>{PAPEIS.find((p) => p.id === m.role)?.rotulo}</Emblema>
              <select value={m.role} onChange={(e) => mudarPapel(m, e.target.value)}
                className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-300 outline-none focus:border-sky-500">
                {PAPEIS.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
              </select>
              <button onClick={() => remover(m)} title="Remover" className="text-slate-600 hover:text-red-400">
                <Trash2 size={15} />
              </button>
            </div>
          </Cartao>
        ))}
      </div>

      {convites.data?.convites.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Convites pendentes</h2>
          <div className="space-y-2">
            {convites.data.convites.map((c: any) => (
              <Cartao key={c.id} className="p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200 truncate">{c.email}</p>
                  <p className="text-[11px] text-slate-500">{PAPEIS.find((p) => p.id === c.role)?.rotulo} · expira em {quando(c.expires_at)}</p>
                </div>
                <button onClick={() => cancelarConvite(c.id)} title="Cancelar convite" className="text-slate-600 hover:text-red-400">
                  <XCircle size={16} />
                </button>
              </Cartao>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
