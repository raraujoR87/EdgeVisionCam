"use client"
import React, { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Shield, CheckCircle2 } from 'lucide-react';
import { Botao, Campo, Erro } from '../../../components/ui';

export default function AceitarConvitePage() {
  const { token } = useParams<{ token: string }>();
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [concluido, setConcluido] = useState<{ email: string; contaNova: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const aceitar = async (e: React.FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const r = await fetch('/api/convites/aceitar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, senha }),
      });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(dados.error || 'Não foi possível aceitar o convite.');
      setConcluido({ email: dados.email, contaNova: dados.conta_nova });
    } catch (err: any) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8 justify-center">
          <div className="bg-sky-600 p-2 rounded-lg"><Shield size={20} className="text-white" /></div>
          <span className="text-lg font-semibold tracking-tight">VMS Cloud</span>
        </div>

        {concluido ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center space-y-3">
            <CheckCircle2 size={32} className="mx-auto text-emerald-400" />
            <p className="font-medium">Convite aceito</p>
            <p className="text-sm text-slate-400">
              {concluido.contaNova
                ? `Sua conta ${concluido.email} foi criada.`
                : `A organização foi adicionada à sua conta ${concluido.email}.`}
            </p>
            <Link href="/login" className="inline-block text-sm text-sky-400 hover:text-sky-300 underline">
              Ir para o login
            </Link>
          </div>
        ) : (
          <form onSubmit={aceitar} className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
            <div>
              <p className="font-medium">Você foi convidado</p>
              <p className="text-xs text-slate-500 mt-1">
                Defina uma senha para sua conta. Se você já tem uma conta VMS Cloud,
                informe a senha dela para vincular esta organização.
              </p>
            </div>
            <Campo type="password" required minLength={10} rotulo="Senha"
              dica="Mínimo de 10 caracteres." value={senha}
              onChange={(e) => setSenha(e.target.value)} />
            {erro && <Erro mensagem={erro} />}
            <Botao type="submit" carregando={enviando} className="w-full">Aceitar convite</Botao>
          </form>
        )}
      </div>
    </div>
  );
}
