"use client"
import React, { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useSWR from 'swr';
import {
  Shield, LayoutDashboard, ListChecks, BarChart3, Users, LogOut,
  Building2, ChevronDown, Loader2, AlertTriangle,
} from 'lucide-react';
import { buscar } from '../../components/ui';
import { CtxConsole, ContextoConsole, Organizacao, Sessao } from './contexto';

/**
 * Console do cliente.
 *
 * O painel que existia era o back-office do fornecedor: clientes, deploys,
 * auditoria da frota. O lojista e os funcionários dele — que são quem usa o
 * produto todo dia — não tinham para onde ir; entravam no mesmo painel com
 * alguns itens de menu escondidos.
 *
 * Isto aqui é a área do cliente, com navegação própria. A separação não é
 * estética: enquanto as duas visões compartilham o mesmo layout, toda tela
 * nova precisa lembrar de se esconder do público errado, e uma esquecida vira
 * exposição. Aqui, o que está sob /console é do cliente por construção.
 *
 * O isolamento de dados continua onde sempre esteve: na RLS do Postgres. Esta
 * camada decide o que mostrar, nunca o que é permitido.
 */

const ITENS = [
  { href: '/console', rotulo: 'Painel', Icone: LayoutDashboard, exato: true },
  { href: '/console/eventos', rotulo: 'Triagem', Icone: ListChecks },
  { href: '/console/relatorios', rotulo: 'Relatórios', Icone: BarChart3 },
  { href: '/console/equipe', rotulo: 'Equipe', Icone: Users, somenteAdmin: true },
];

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: sessao, error, isLoading } = useSWR<Sessao>('/api/me', buscar);
  const [orgId, setOrgId] = useState<number | null>(null);

  // Restaura a organização escolhida. Sem isto, um gestor de várias redes
  // recomeça na primeira toda vez que recarrega a página.
  useEffect(() => {
    const salvo = Number(localStorage.getItem('console_org') || 0);
    if (salvo) setOrgId(salvo);
  }, []);

  const orgAtiva = useMemo(() => {
    if (!sessao?.organizacoes.length) return null;
    // Confere contra a lista vinda do servidor: um id colado no localStorage
    // não vira acesso, porque a organização precisa estar entre as que a RLS
    // devolveu para esta sessão.
    return sessao.organizacoes.find((o) => o.id === orgId) ?? sessao.organizacoes[0];
  }, [sessao, orgId]);

  const valor: ContextoConsole = useMemo(() => ({
    sessao: sessao ?? null,
    orgAtiva,
    // Só recorta quando há mais de uma: com uma organização, filtrar é
    // redundante e ainda esconderia dados se o id divergisse.
    filtroOrg: orgAtiva && (sessao?.organizacoes.length ?? 0) > 1
      ? `organization_id=${orgAtiva.id}` : '',
    papelNaOrg: sessao?.super_admin ? 'SUPER_ADMIN' : (orgAtiva?.papel ?? 'STORE_VIEWER'),
  }), [sessao, orgAtiva]);

  const sair = () => {
    localStorage.removeItem('admin_token');
    document.cookie = 'admin_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    window.location.href = '/login';
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-slate-950 flex items-center justify-center">
        <Loader2 className="animate-spin text-sky-500" size={28} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertTriangle size={36} className="mx-auto mb-3 text-red-400" />
          <p className="text-slate-200 font-medium">Não foi possível carregar a sessão</p>
          <p className="text-sm text-slate-500 mt-1">{error.message}</p>
          <button onClick={sair} className="text-sm text-sky-400 hover:text-sky-300 underline mt-4">
            Entrar novamente
          </button>
        </div>
      </div>
    );
  }

  // Conta sem associação nenhuma. Acontece de verdade: um usuário criado antes
  // da migração multi-tenant não pertence a organização alguma e enxerga zero
  // linhas em tudo. Sem esta tela, ele veria quatro painéis vazios e concluiria
  // que o produto está quebrado.
  if (sessao && sessao.escopo === 'sem_acesso') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <Building2 size={36} className="mx-auto mb-3 text-slate-700" />
          <p className="text-slate-200 font-medium">Sua conta ainda não está vinculada a um cliente</p>
          <p className="text-sm text-slate-500 mt-2">
            O acesso existe, mas nenhuma organização foi associada a {sessao.usuario.email}.
            Peça ao administrador da sua empresa, ou ao suporte, para incluir você na equipe.
          </p>
          <button onClick={sair} className="text-sm text-sky-400 hover:text-sky-300 underline mt-4">
            Sair
          </button>
        </div>
      </div>
    );
  }

  const podeAdministrar = valor.papelNaOrg === 'STORE_ADMIN' || !!sessao?.super_admin;
  const itens = ITENS.filter((i) => !i.somenteAdmin || podeAdministrar);

  return (
    <CtxConsole.Provider value={valor}>
      <div className="min-h-screen bg-slate-950 text-slate-100 lg:pl-60">
        <aside className="hidden lg:flex w-60 fixed left-0 top-0 h-screen bg-slate-900 border-r border-slate-800 flex-col z-40">
          <div className="px-5 py-5 flex items-center gap-2.5 border-b border-slate-800/70">
            <div className="bg-sky-600 p-1.5 rounded-lg"><Shield size={18} className="text-white" /></div>
            <span className="font-semibold tracking-tight">VisionCam</span>
          </div>

          {sessao && sessao.organizacoes.length > 0 && (
            <div className="px-3 pt-3">
              {sessao.organizacoes.length > 1 ? (
                <div className="relative">
                  <select
                    value={orgAtiva?.id ?? ''}
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      setOrgId(id);
                      localStorage.setItem('console_org', String(id));
                    }}
                    className="w-full appearance-none px-3 py-2 pr-8 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 outline-none focus:border-sky-500"
                  >
                    {sessao.organizacoes.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                </div>
              ) : (
                <div className="px-3 py-2 bg-slate-950/60 border border-slate-800 rounded-lg">
                  <p className="text-sm text-slate-200 truncate">{orgAtiva?.name}</p>
                  <p className="text-[11px] text-slate-500 capitalize">plano {orgAtiva?.plan}</p>
                </div>
              )}
              {orgAtiva && orgAtiva.status !== 'ativa' && (
                <p className="mt-2 px-2 py-1.5 text-[11px] text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded">
                  Conta {orgAtiva.status}. Os dados continuam visíveis; novas instalações estão bloqueadas.
                </p>
              )}
            </div>
          )}

          <nav className="flex-1 px-3 py-3 space-y-1">
            {itens.map(({ href, rotulo, Icone, exato }) => {
              const ativo = exato ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition ${
                    ativo ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                  }`}
                >
                  <Icone size={17} />{rotulo}
                </Link>
              );
            })}
          </nav>

          {sessao?.super_admin && (
            <Link
              href="/dashboard"
              className="mx-3 mb-2 px-3 py-2 rounded-lg text-xs text-slate-500 hover:text-sky-300 hover:bg-slate-800/60 transition"
            >
              ← Painel do fornecedor
            </Link>
          )}

          <div className="px-3 pb-3 pt-2 border-t border-slate-800/70">
            <p className="px-3 pb-2 text-[11px] text-slate-500 truncate" title={sessao?.usuario.email}>
              {sessao?.usuario.email}
            </p>
            <button
              onClick={sair}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-red-950/30 hover:text-red-300 transition"
            >
              <LogOut size={17} />Sair
            </button>
          </div>
        </aside>

        {/* Navegação em barra inferior no celular. Triagem de alerta acontece no
            chão da loja, com o telefone na mão — uma sidebar de 240px ali é
            inutilizável. */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900 border-t border-slate-800 flex">
          {itens.map(({ href, rotulo, Icone, exato }) => {
            const ativo = exato ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[11px] ${
                  ativo ? 'text-sky-400' : 'text-slate-500'
                }`}
              >
                <Icone size={19} />{rotulo}
              </Link>
            );
          })}
        </nav>

        <main className="pb-20 lg:pb-0">{children}</main>
      </div>
    </CtxConsole.Provider>
  );
}
