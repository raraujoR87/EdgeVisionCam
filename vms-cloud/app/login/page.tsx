"use client"
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield } from 'lucide-react';
import { Botao, Campo, Erro } from '../../components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: senha }),
      });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(dados.error || 'Não foi possível entrar.');
      localStorage.setItem('vms_token', dados.token);
      router.replace('/painel');
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
        <form onSubmit={entrar} className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <Campo type="email" required autoFocus rotulo="E-mail" value={email}
            onChange={(e) => setEmail(e.target.value)} />
          <Campo type="password" required rotulo="Senha" value={senha}
            onChange={(e) => setSenha(e.target.value)} />
          {erro && <Erro mensagem={erro} />}
          <Botao type="submit" carregando={enviando} className="w-full">Entrar</Botao>
        </form>
        <p className="text-[11px] text-slate-600 text-center mt-4">
          Acesso por convite. Se você ainda não recebeu um, fale com o administrador da sua empresa.
        </p>
      </div>
    </div>
  );
}
