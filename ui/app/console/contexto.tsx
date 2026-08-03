"use client"
import { createContext, useContext } from 'react';

/**
 * Contexto compartilhado pelo console do cliente.
 *
 * Vive fora de `layout.tsx` por imposição do Next.js: um arquivo de layout só
 * pode exportar o componente e um punhado de campos de configuração
 * conhecidos. Exportar um hook dali quebra o build — e quebra na etapa de
 * verificação de tipos, não na compilação, então `tsc --noEmit` passa e o erro
 * só aparece no deploy. Já custou três deploys neste projeto.
 */

export interface Organizacao {
  id: number; name: string; slug: string; plan: string; status: string; papel: string;
}

export interface Loja {
  id: number; name: string; location: string | null; organization_id: number;
}

export interface Sessao {
  usuario: { id: number | null; email: string };
  papel: string;
  super_admin: boolean;
  escopo: 'fornecedor' | 'cliente' | 'sem_acesso';
  organizacoes: Organizacao[];
  lojas: Loja[];
}

/**
 * Organização ativa, compartilhada pelas telas.
 *
 * Quem pertence a uma rede só não percebe que existe seletor. Quem administra
 * várias precisa que o painel, a triagem e o relatório concordem sobre qual
 * está sendo vista — passar isso por query string em cada link daria telas
 * discordando entre si depois de um F5.
 */
export interface ContextoConsole {
  sessao: Sessao | null;
  orgAtiva: Organizacao | null;
  /** Sufixo pronto para concatenar em URL de API. Vazio quando não há recorte. */
  filtroOrg: string;
  papelNaOrg: string;
}

export const CtxConsole = createContext<ContextoConsole>({
  sessao: null, orgAtiva: null, filtroOrg: '', papelNaOrg: 'STORE_VIEWER',
});

export function useConsole() {
  return useContext(CtxConsole);
}
