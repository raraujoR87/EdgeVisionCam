"use client"
import React from 'react';
import { Loader2, Inbox, AlertTriangle, X, Search, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Primitivas da interface.
 *
 * Existiam zero componentes compartilhados: cada página reinventava botão,
 * tabela e estado vazio. O resultado agregado parecia feito por pessoas
 * diferentes — porque, na prática, foi. Não era falta de capricho numa tela,
 * era ausência de sistema, e cada tela nova aumentava a divergência.
 *
 * Tudo aqui assume tema escuro e a mesma escala de espaçamento. Um componente
 * novo entra neste arquivo, não na página.
 */

// ── Botão ──────────────────────────────────────────────────────────

type Variante = 'primario' | 'secundario' | 'fantasma' | 'perigo';

const ESTILO_BOTAO: Record<Variante, string> = {
  primario: 'bg-sky-600 hover:bg-sky-500 text-white',
  secundario: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700',
  fantasma: 'text-slate-400 hover:text-slate-100 hover:bg-slate-800',
  perigo: 'bg-red-600/90 hover:bg-red-500 text-white',
};

export function Botao({
  variante = 'primario', carregando, Icone, children, className = '', ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variante?: Variante; carregando?: boolean; Icone?: any;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || carregando}
      className={`inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg
        text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed
        ${ESTILO_BOTAO[variante]} ${className}`}
    >
      {carregando ? <Loader2 size={15} className="animate-spin" /> : Icone && <Icone size={15} />}
      {children}
    </button>
  );
}

// ── Campos ─────────────────────────────────────────────────────────

const BASE_CAMPO =
  'w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-slate-100 ' +
  'text-sm placeholder:text-slate-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500/40 outline-none transition';

export function Campo({ rotulo, dica, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {
  rotulo?: string; dica?: string;
}) {
  return (
    <label className="block">
      {rotulo && <span className="block text-xs font-medium text-slate-400 mb-1.5">{rotulo}</span>}
      <input {...props} className={BASE_CAMPO} />
      {dica && <span className="block text-[11px] text-slate-500 mt-1">{dica}</span>}
    </label>
  );
}

export function Selecao({ rotulo, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & {
  rotulo?: string;
}) {
  return (
    <label className="block">
      {rotulo && <span className="block text-xs font-medium text-slate-400 mb-1.5">{rotulo}</span>}
      <select {...props} className={BASE_CAMPO}>{children}</select>
    </label>
  );
}

export function Busca({ valor, aoMudar, placeholder = 'Buscar…' }: {
  valor: string; aoMudar: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className="relative flex-1 max-w-xs">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
        placeholder={placeholder}
        className={`${BASE_CAMPO} pl-9`}
      />
      {valor && (
        <button
          onClick={() => aoMudar('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// ── Contêineres ────────────────────────────────────────────────────

export function Cartao({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-slate-900 border border-slate-800 rounded-xl ${className}`}>{children}</div>
  );
}

export function Cabecalho({ titulo, descricao, Icone, acao }: {
  titulo: string; descricao?: string; Icone?: any; acao?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100 flex items-center gap-2.5">
          {Icone && <Icone size={24} className="text-sky-400" />}
          {titulo}
        </h1>
        {descricao && <p className="text-sm text-slate-400 mt-1 max-w-2xl">{descricao}</p>}
      </div>
      {acao}
    </div>
  );
}

export function Emblema({ tom = 'neutro', children }: {
  tom?: 'neutro' | 'sucesso' | 'aviso' | 'perigo' | 'info'; children: React.ReactNode;
}) {
  const tons = {
    neutro: 'bg-slate-800 text-slate-300',
    sucesso: 'bg-emerald-900/50 text-emerald-300',
    aviso: 'bg-amber-900/50 text-amber-300',
    perigo: 'bg-red-900/50 text-red-300',
    info: 'bg-sky-900/50 text-sky-300',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${tons[tom]}`}>
      {children}
    </span>
  );
}

// ── Estados ────────────────────────────────────────────────────────
// Os três precisam ser distintos. "Carregando", "deu erro" e "não há nada"
// viravam a mesma tela em branco, e o usuário não sabia se esperava ou agia.

export function Carregando({ linhas = 3 }: { linhas?: number }) {
  return (
    <div className="space-y-2.5" aria-busy="true">
      {Array.from({ length: linhas }).map((_, i) => (
        <div key={i} className="h-20 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
      ))}
    </div>
  );
}

export function Vazio({ Icone = Inbox, titulo, descricao, acao }: {
  Icone?: any; titulo: string; descricao?: string; acao?: React.ReactNode;
}) {
  return (
    <div className="text-center py-16">
      <Icone size={40} className="mx-auto mb-3 text-slate-700" />
      <p className="text-sm text-slate-400 font-medium">{titulo}</p>
      {descricao && <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">{descricao}</p>}
      {acao && <div className="mt-4">{acao}</div>}
    </div>
  );
}

export function Erro({ mensagem, aoTentarNovamente }: {
  mensagem: string; aoTentarNovamente?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 p-4 bg-red-950/40 border border-red-900/60 rounded-xl">
      <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-red-200">{mensagem}</p>
        {aoTentarNovamente && (
          <button onClick={aoTentarNovamente} className="text-xs text-red-300 hover:text-red-100 underline mt-1">
            Tentar novamente
          </button>
        )}
      </div>
    </div>
  );
}

// ── Medidor de consumo ─────────────────────────────────────────────

export function Medidor({ atual, limite, rotulo, Icone }: {
  atual: number; limite: number; rotulo: string; Icone?: any;
}) {
  const proporcao = limite > 0 ? Math.min(atual / limite, 1) : 0;
  const estourou = atual >= limite;
  // Avisa em 80%, não em 100%: depois de estourar já é tarde para agir.
  const perto = !estourou && proporcao >= 0.8;

  return (
    <div className="flex-1 min-w-[130px]">
      <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">
        {Icone && <Icone size={13} />}
        <span>{rotulo}</span>
        <span className={`ml-auto font-mono tabular-nums ${
          estourou ? 'text-red-400' : perto ? 'text-amber-400' : 'text-slate-300'
        }`}>
          {atual}/{limite}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            estourou ? 'bg-red-500' : perto ? 'bg-amber-500' : 'bg-sky-500'
          }`}
          style={{ width: `${proporcao * 100}%` }}
        />
      </div>
    </div>
  );
}

// ── Paginação ──────────────────────────────────────────────────────

export function Paginacao({ pagina, porPagina, total, aoMudar }: {
  pagina: number; porPagina: number; total: number; aoMudar: (p: number) => void;
}) {
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  if (total <= porPagina) return null;

  return (
    <div className="flex items-center justify-between mt-4 text-xs text-slate-400">
      <span className="tabular-nums">
        {pagina * porPagina + 1}–{Math.min((pagina + 1) * porPagina, total)} de {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => aoMudar(pagina - 1)}
          disabled={pagina === 0}
          className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="px-2 tabular-nums">{pagina + 1} / {paginas}</span>
        <button
          onClick={() => aoMudar(pagina + 1)}
          disabled={pagina + 1 >= paginas}
          className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

// ── Indicadores ────────────────────────────────────────────────────

export function Indicador({ rotulo, valor, sufixo, tom = 'neutro', Icone, nota }: {
  rotulo: string; valor: React.ReactNode; sufixo?: string;
  tom?: 'neutro' | 'sucesso' | 'aviso' | 'perigo'; Icone?: any; nota?: string;
}) {
  const cores = {
    neutro: 'text-slate-100',
    sucesso: 'text-emerald-400',
    aviso: 'text-amber-400',
    perigo: 'text-red-400',
  };
  return (
    <Cartao className="p-4">
      <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
        {Icone && <Icone size={14} />}
        <span>{rotulo}</span>
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${cores[tom]}`}>
        {valor}
        {sufixo && <span className="text-sm font-normal text-slate-500 ml-1">{sufixo}</span>}
      </div>
      {nota && <p className="text-[11px] text-slate-500 mt-1">{nota}</p>}
    </Cartao>
  );
}

// ── Utilitários ────────────────────────────────────────────────────

export function tokenLocal(): string {
  return (typeof window !== 'undefined' && localStorage.getItem('admin_token')) || '';
}

/** Fetcher do SWR já com o token. Repetido em cada página antes disto. */
export const buscar = (url: string) =>
  fetch(url, { headers: { Authorization: `Bearer ${tokenLocal()}` } }).then(async (r) => {
    const corpo = await r.json().catch(() => ({}));
    // Erro da API vira exceção para o SWR: antes ele caía no `data` e a tela
    // tentava renderizar `{error: "..."}` como lista.
    if (!r.ok) throw new Error(corpo.error || `Falha ${r.status}`);
    return corpo;
  });

export async function enviar(url: string, metodo: string, corpo?: unknown) {
  const res = await fetch(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenLocal()}` },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.error || `Falha ${res.status}`);
  return dados;
}
