"use client"
import React, { useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  Users, UserPlus, Trash2, ShieldCheck, Eye, ClipboardCheck, KeyRound, Info,
} from 'lucide-react';
import {
  Cartao, Cabecalho, Campo, Selecao, Botao, Emblema, Carregando, Vazio, Erro, Busca,
  buscar, enviar, quando,
} from '../../../components/ui';
import { useConsole } from '../contexto';

/**
 * Equipe do cliente.
 *
 * Quem pode ver e quem pode julgar. A distinção importa mais aqui do que num
 * SaaS comum: classificar um alerta como furto é o registro que pode embasar
 * uma abordagem, e nem todo mundo que precisa acompanhar os números deve poder
 * produzi-lo.
 *
 * Por isso a triagem é fechada ao STORE_VIEWER — em tela e na rota — e cada
 * mudança de papel entra na trilha de auditoria.
 */

const PAPEIS = [
  {
    id: 'STORE_ADMIN', rotulo: 'Administrador', Icone: ShieldCheck,
    descricao: 'Gerencia a equipe, vê tudo e classifica alertas.',
  },
  {
    id: 'STORE_OPERATOR', rotulo: 'Operador', Icone: ClipboardCheck,
    descricao: 'Faz a triagem: assiste aos clipes e classifica os alertas.',
  },
  {
    id: 'STORE_VIEWER', rotulo: 'Observador', Icone: Eye,
    descricao: 'Acompanha painéis e relatórios. Não classifica alertas.',
  },
];

const TOM_PAPEL: Record<string, 'sucesso' | 'info' | 'neutro'> = {
  STORE_ADMIN: 'sucesso', STORE_OPERATOR: 'info', STORE_VIEWER: 'neutro',
};

interface Membro {
  id: number;
  email: string;
  membership_id: number;
  role: string;
  organization_id: number;
  organization_name: string | null;
  store_id: number | null;
  created_at: string;
}

export default function EquipePage() {
  const { sessao, orgAtiva, papelNaOrg } = useConsole();
  const { data, error, isLoading, mutate } = useSWR<Membro[]>('/api/users', buscar);

  const [convidando, setConvidando] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', role: 'STORE_OPERATOR', store_id: '' });
  const [salvando, setSalvando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [termo, setTermo] = useState('');

  const podeAdministrar = papelNaOrg === 'STORE_ADMIN' || !!sessao?.super_admin;

  // A rota devolve todos os membros das organizações que o solicitante
  // administra. O recorte pela organização ativa acontece aqui, para que o
  // seletor da barra lateral valha também nesta tela.
  const membros = useMemo(() => {
    const lista = (data ?? []).filter(
      (m) => !orgAtiva || Number(m.organization_id) === orgAtiva.id);
    const t = termo.trim().toLowerCase();
    return t ? lista.filter((m) => m.email.toLowerCase().includes(t)) : lista;
  }, [data, orgAtiva, termo]);

  const lojas = (sessao?.lojas ?? []).filter(
    (l) => !orgAtiva || l.organization_id === orgAtiva.id);

  const convidar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSalvando(true);
    setAviso(null);
    try {
      await enviar('/api/users', 'POST', {
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        organization_id: orgAtiva?.id,
        store_id: form.store_id ? Number(form.store_id) : null,
      });
      setConvidando(false);
      setForm({ email: '', password: '', role: 'STORE_OPERATOR', store_id: '' });
      mutate();
    } catch (erro: any) {
      setAviso(erro.message);
    }
    setSalvando(false);
  };

  const mudarPapel = async (m: Membro, role: string) => {
    setAviso(null);
    mutate(
      (atual) => atual?.map((x) => (x.membership_id === m.membership_id ? { ...x, role } : x)),
      { revalidate: false },
    );
    try {
      await enviar('/api/users', 'PATCH', { membership_id: m.membership_id, role });
    } catch (erro: any) {
      setAviso(erro.message);
    }
    mutate();
  };

  const remover = async (m: Membro) => {
    if (!confirm(`Remover ${m.email} da equipe? A conta continua existindo, mas perde o acesso a estes dados.`)) return;
    setAviso(null);
    try {
      await enviar(`/api/users?membership_id=${m.membership_id}`, 'DELETE');
      mutate();
    } catch (erro: any) {
      setAviso(erro.message);
    }
  };

  if (!podeAdministrar) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Vazio
          Icone={Users}
          titulo="Gestão de equipe restrita aos administradores"
          descricao="Peça a um administrador da sua empresa para incluir ou alterar acessos."
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Cabecalho
        Icone={Users}
        titulo="Equipe"
        descricao={orgAtiva
          ? `Quem tem acesso aos dados de ${orgAtiva.name}, e o que cada um pode fazer.`
          : 'Quem tem acesso, e o que cada um pode fazer.'}
        acao={<Botao Icone={UserPlus} onClick={() => setConvidando((v) => !v)}>Adicionar pessoa</Botao>}
      />

      {aviso && <div className="mb-4"><Erro mensagem={aviso} /></div>}

      {convidando && (
        <Cartao className="p-4 mb-6">
          <form onSubmit={convidar}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo
                autoFocus type="email" required rotulo="E-mail" placeholder="pessoa@empresa.com.br"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <Campo
                type="text" required minLength={10} rotulo="Senha inicial"
                placeholder="mínimo 10 caracteres"
                dica="Peça para trocar no primeiro acesso."
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <Selecao
                rotulo="Papel" value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {PAPEIS.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
              </Selecao>
              {lojas.length > 1 && (
                <Selecao
                  rotulo="Loja (opcional)" value={form.store_id}
                  onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                >
                  <option value="">Todas as lojas</option>
                  {lojas.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Selecao>
              )}
            </div>

            <p className="text-xs text-slate-500 mt-3">
              {PAPEIS.find((p) => p.id === form.role)?.descricao}
            </p>

            {/* Dito na tela porque é um comportamento que o operador precisa
                saber antes de agir: hoje quem convida escolhe a senha. Convite
                por e-mail com token de uso único ainda não existe, e fingir o
                contrário levaria alguém a mandar a senha por WhatsApp achando
                que era provisória. */}
            <p className="flex items-start gap-2 text-[11px] text-amber-300/80 bg-amber-950/20 border border-amber-900/40 rounded-lg p-2.5 mt-3">
              <KeyRound size={13} className="mt-px shrink-0" />
              A senha é definida por você e precisa ser entregue à pessoa por um canal seguro.
              O convite por e-mail com link de uso único ainda não está disponível.
            </p>

            <div className="flex gap-2 mt-4">
              <Botao type="submit" carregando={salvando} disabled={!form.email.trim() || form.password.length < 10}>
                Adicionar
              </Botao>
              <Botao type="button" variante="fantasma" onClick={() => setConvidando(false)}>
                Cancelar
              </Botao>
            </div>
          </form>
        </Cartao>
      )}

      {(data?.length ?? 0) > 5 && (
        <div className="mb-4"><Busca valor={termo} aoMudar={setTermo} placeholder="Buscar por e-mail…" /></div>
      )}

      {isLoading && <Carregando linhas={3} />}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}

      {!isLoading && !error && membros.length === 0 && (
        <Vazio
          Icone={Users}
          titulo={termo ? 'Ninguém corresponde à busca' : 'Só você tem acesso'}
          descricao={termo ? undefined : 'Adicione as pessoas que vão acompanhar os alertas com você.'}
          acao={termo ? undefined : <Botao Icone={UserPlus} onClick={() => setConvidando(true)}>Adicionar pessoa</Botao>}
        />
      )}

      <div className="space-y-2">
        {membros.map((m) => {
          const eu = m.email === sessao?.usuario.email;
          return (
            <Cartao key={m.membership_id} className="p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-slate-100 truncate">{m.email}</span>
                    {eu && <Emblema tom="info">você</Emblema>}
                    <Emblema tom={TOM_PAPEL[m.role] ?? 'neutro'}>
                      {PAPEIS.find((p) => p.id === m.role)?.rotulo ?? m.role}
                    </Emblema>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {m.store_id
                      ? `${lojas.find((l) => l.id === m.store_id)?.name ?? `loja ${m.store_id}`} · `
                      : 'todas as lojas · '}
                    desde {quando(m.created_at)}
                  </p>
                </div>

                <select
                  value={m.role}
                  onChange={(e) => mudarPapel(m, e.target.value)}
                  className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-300 outline-none focus:border-sky-500"
                >
                  {PAPEIS.map((p) => <option key={p.id} value={p.id}>{p.rotulo}</option>)}
                </select>

                <Botao
                  variante="fantasma" className="!px-2 hover:!text-red-400"
                  title="Remover do time" Icone={Trash2}
                  onClick={() => remover(m)}
                >{''}</Botao>
              </div>
            </Cartao>
          );
        })}
      </div>

      <Cartao className="p-4 mt-6">
        <h2 className="text-sm font-medium text-slate-200 mb-3 flex items-center gap-2">
          <Info size={15} />O que cada papel pode fazer
        </h2>
        <ul className="space-y-2.5">
          {PAPEIS.map((p) => (
            <li key={p.id} className="flex items-start gap-2.5 text-sm">
              <p.Icone size={15} className="mt-0.5 shrink-0 text-slate-500" />
              <div>
                <span className="text-slate-200">{p.rotulo}</span>
                <p className="text-xs text-slate-500">{p.descricao}</p>
              </div>
            </li>
          ))}
        </ul>
      </Cartao>
    </div>
  );
}
