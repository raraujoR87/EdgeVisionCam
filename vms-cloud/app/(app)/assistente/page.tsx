"use client"
import React, { useState } from 'react';
import { Bot, Send } from 'lucide-react';
import { Cabecalho, Cartao, Botao, Erro, Selecao, enviar } from '../../../components/ui';
import { useApp } from '../../../components/contexto-app';

/**
 * Assistente: pergunte sobre os eventos da sua organização em linguagem comum.
 *
 * Ele só responde com o que você já pode ver. Não recebe imagens nem dados de
 * outro cliente, e não grava o texto da pergunta na auditoria.
 */

const SUGESTOES = [
  'Quantos alertas suspeitos tivemos esta semana?',
  'Em qual câmera houve mais alertas que procediam?',
  'Algum horário concentra os eventos?',
  'A IA está acertando? Explique a taxa de acerto.',
];

interface Troca { pergunta: string; resposta?: string; erro?: string }

export default function AssistentePage() {
  const { orgAtiva } = useApp();
  const [texto, setTexto] = useState('');
  const [dias, setDias] = useState(30);
  const [trocas, setTrocas] = useState<Troca[]>([]);
  const [enviando, setEnviando] = useState(false);

  const perguntar = async (pergunta: string) => {
    const p = pergunta.trim();
    if (p.length < 3 || enviando) return;
    setEnviando(true);
    setTexto('');
    setTrocas((t) => [...t, { pergunta: p }]);
    try {
      const r = await enviar('/api/assistente', 'POST', {
        pergunta: p, dias, organization_id: orgAtiva?.id ?? null,
      });
      setTrocas((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, resposta: r.resposta } : x)));
    } catch (e: any) {
      setTrocas((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, erro: e.message } : x)));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Cabecalho Icone={Bot} titulo="Assistente" descricao="Pergunte sobre os eventos da sua organização. Ele responde só com dados que você já pode ver." />

      <div className="flex items-center gap-3 mb-4">
        <span className="text-xs text-slate-500">Período</span>
        <div className="w-40">
          <Selecao value={dias} onChange={(e) => setDias(Number(e.target.value))}>
            <option value={7}>últimos 7 dias</option>
            <option value={30}>últimos 30 dias</option>
            <option value={90}>últimos 90 dias</option>
          </Selecao>
        </div>
      </div>

      <div className="space-y-4 mb-6">
        {trocas.length === 0 && (
          <div className="grid sm:grid-cols-2 gap-2">
            {SUGESTOES.map((s) => (
              <button key={s} onClick={() => perguntar(s)}
                className="text-left text-sm text-slate-300 p-3 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 transition">
                {s}
              </button>
            ))}
          </div>
        )}
        {trocas.map((t, i) => (
          <div key={i} className="space-y-2">
            <div className="flex justify-end">
              <p className="max-w-[85%] text-sm bg-sky-900/40 border border-sky-800/50 rounded-xl px-3.5 py-2">{t.pergunta}</p>
            </div>
            <Cartao className="p-4">
              {t.resposta && <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">{t.resposta}</p>}
              {t.erro && <Erro mensagem={t.erro} />}
              {!t.resposta && !t.erro && <p className="text-xs text-slate-500">Consultando os eventos…</p>}
            </Cartao>
          </div>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); perguntar(texto); }} className="flex gap-2">
        <input value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={500}
          placeholder="Ex.: houve mais alertas à noite na semana passada?"
          className="flex-1 px-3 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-sm outline-none focus:border-sky-500" />
        <Botao type="submit" Icone={Send} carregando={enviando} disabled={texto.trim().length < 3}>Perguntar</Botao>
      </form>
    </div>
  );
}
