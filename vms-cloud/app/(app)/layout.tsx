"use client"
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  Shield, LayoutDashboard, ListChecks, MapPin, Users, Bot, ScrollText, Building2, LogOut, ChevronDown, Loader2,
} from 'lucide-react';
import { buscar, Erro } from '../../components/ui';
import { CtxApp, type ContextoApp, type Sessao } from '../../components/contexto-app';

const ITENS = [
  { href: '/painel', rotulo: 'Painel', Icone: LayoutDashboard, todos: true },
  { href: '/eventos', rotulo: 'Eventos', Icone: ListChecks, todos: true },
  { href: '/locais', rotulo: 'Locais e agentes', Icone: MapPin, todos: true },
  { href: '/assistente', rotulo: 'Assistente', Icone: Bot, todos: true },
  { href: '/equipe', rotulo: 'Equipe', Icone: Users, admin: true },
  { href: '/auditoria', rotulo: 'Auditoria', Icone: ScrollText, admin: true },
  { href: '/plataforma', rotulo: 'Fornecedor', Icone: Building2, fornecedor: true },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: sessao, error, isLoading } = useSWR<Sessao>('/api/me', buscar, { shouldRetryOnError: false });
  const [orgId, setOrgId] = useState<number | null>(null);

  useEffect(() => {
    const salvo = Number(localStorage.getItem('vms_org') || 0);
    if (salvo) setOrgId(salvo);
  }, []);

  // Sessão inválida ou expirada: sai e volta ao login. Não tenta adivinhar.
  useEffect(() => {
    if (error && /Não autenticado|Sessão inválida/i.test(error.message)) {
      localStorage.removeItem('vms_token');
      router.replace('/login');
    }
  }, [error, router]);

  const orgAtiva = useMemo(() => {
    if (!sessao?.organizacoes.length) return null;
    // Confere contra a lista que o servidor devolveu: um id no localStorage não
    // vira acesso, porque o banco é quem decide o que existe para este usuário.
    return sessao.organizacoes.find((o) => o.id === orgId) ?? sessao.organizacoes[0];
  }, [sessao, orgId]);

  const valor: ContextoApp = useMemo(() => {
    const papel = sessao?.plataforma ? 'FORNECEDOR' : (orgAtiva?.papel ?? null);
    return {
      sessao: sessao ?? null,
      orgAtiva,
      filtroOrg: orgAtiva ? `org=${orgAtiva.id}` : '',
      papel,
      podeRevisar: papel === 'ADMIN' || papel === 'OPERADOR',
      podeAdministrar: papel === 'ADMIN',
    };
  }, [sessao, orgAtiva]);

  const sair = () => {
    localStorage.removeItem('vms_token');
    router.replace('/login');
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-950">
        <Loader2 className="animate-spin text-sky-500" size={28} />
      </div>
    );
  }

  if (error && !/Não autenticado|Sessão inválida/i.test(error.message)) {
    return <div className="p-6 max-w-md mx-auto mt-20"><Erro mensagem={error.message} /></div>;
  }

  if (sessao && sessao.escopo === 'sem_acesso') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <Building2 size={36} className="mx-auto mb-3 text-slate-700" />
          <p className="font-medium">Sua conta ainda não está vinculada a um cliente</p>
          <p className="text-sm text-slate-500 mt-2">
            {sessao.usuario.email} não pertence a nenhuma organização. Peça ao administrador da sua
            empresa um convite.
          </p>
          <button onClick={sair} className="text-sm text-sky-400 hover:text-sky-300 underline mt-4">Sair</button>
        </div>
      </div>
    );
  }

  const itens = ITENS.filter((i) => {
    if (i.fornecedor) return !!sessao?.plataforma;
    if (i.admin) return valor.podeAdministrar;
    return true;
  });

  const trocarOrg = (id: number) => {
    setOrgId(id);
    localStorage.setItem('vms_org', String(id));
  };

  return (
    <CtxApp.Provider value={valor}>
      <div className="min-h-screen lg:pl-60">
        <aside className="hidden lg:flex w-60 fixed left-0 top-0 h-screen flex-col bg-slate-900 border-r border-slate-800 z-40">
          <div className="px-5 py-5 flex items-center gap-2.5 border-b border-slate-800/70">
            <div className="bg-sky-600 p-1.5 rounded-lg"><Shield size={18} className="text-white" /></div>
            <span className="font-semibold tracking-tight">VMS Cloud</span>
          </div>

          {sessao && sessao.organizacoes.length > 0 && (
            <div className="px-3 pt-3">
              {sessao.organizacoes.length > 1 ? (
                <div className="relative">
                  <select
                    value={orgAtiva?.id ?? ''}
                    onChange={(e) => trocarOrg(Number(e.target.value))}
                    className="w-full appearance-none px-3 py-2 pr-8 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-200 outline-none focus:border-sky-500"
                  >
                    {sessao.organizacoes.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                </div>
              ) : (
                <div className="px-3 py-2 bg-slate-950/60 border border-slate-800 rounded-lg">
                  <p className="text-sm text-slate-200 truncate">{orgAtiva?.nome}</p>
                  <p className="text-[11px] text-slate-500">plano {orgAtiva?.plano} · {orgAtiva?.papel.toLowerCase()}</p>
                </div>
              )}
            </div>
          )}

          <nav className="flex-1 px-3 py-3 space-y-1">
            {itens.map(({ href, rotulo, Icone }) => {
              const ativo = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link key={href} href={href}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition ${
                    ativo ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                  }`}>
                  <Icone size={17} />{rotulo}
                </Link>
              );
            })}
          </nav>

          <div className="px-3 pb-3 pt-2 border-t border-slate-800/70">
            <p className="px-3 pb-2 text-[11px] text-slate-500 truncate" title={sessao?.usuario.email}>
              {sessao?.usuario.email}
            </p>
            <button onClick={sair}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-red-950/30 hover:text-red-300 transition">
              <LogOut size={17} />Sair
            </button>
          </div>
        </aside>

        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900 border-t border-slate-800 flex overflow-x-auto">
          {itens.map(({ href, rotulo, Icone }) => {
            const ativo = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link key={href} href={href}
                className={`flex-1 min-w-[64px] flex flex-col items-center gap-0.5 py-2.5 text-[10px] ${ativo ? 'text-sky-400' : 'text-slate-500'}`}>
                <Icone size={18} />{rotulo.split(' ')[0]}
              </Link>
            );
          })}
        </nav>

        <main className="pb-24 lg:pb-0">
          {/* Por que um mesmo painel serve ao cliente e ao fornecedor: o que muda é
              o que o banco devolve, não a casca. */}
          {sessao?.plataforma && !orgAtiva && pathname !== '/plataforma' && (
            <div className="p-6"><Erro mensagem="Esta conta é do fornecedor e não pertence a um cliente. Use a área Fornecedor." /></div>
          )}
          {children}
        </main>
      </div>
    </CtxApp.Provider>
  );
}
