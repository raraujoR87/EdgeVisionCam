"use client"
import { createContext, useContext } from 'react';

/**
 * Estado compartilhado pelas telas autenticadas.
 *
 * Fica fora de `app/(app)/layout.tsx` porque um layout do Next só pode exportar
 * o componente. Exportar um hook dali quebra o build na etapa de tipos.
 */

export interface Organizacao {
  id: number;
  nome: string;
  slug: string;
  plano: string;
  status: string;
  papel: 'ADMIN' | 'OPERADOR' | 'VISUALIZADOR';
}

export interface Sessao {
  usuario: { id: number; email: string };
  plataforma: boolean;
  escopo: 'fornecedor' | 'cliente' | 'sem_acesso';
  organizacoes: Organizacao[];
}

export interface ContextoApp {
  sessao: Sessao | null;
  orgAtiva: Organizacao | null;
  /** Sufixo para URLs de API. Vazio quando o usuário vê todas as organizações. */
  filtroOrg: string;
  /** Papel na organização ativa. FORNECEDOR quando é a conta do fornecedor. */
  papel: Organizacao['papel'] | 'FORNECEDOR' | null;
  podeRevisar: boolean;
  podeAdministrar: boolean;
}

export const CtxApp = createContext<ContextoApp>({
  sessao: null, orgAtiva: null, filtroOrg: '', papel: null, podeRevisar: false, podeAdministrar: false,
});

export function useApp(): ContextoApp {
  return useContext(CtxApp);
}
