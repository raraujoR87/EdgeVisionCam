"use client"
import React, { useState } from 'react'
import { Shield, Key, Mail, Loader2 } from 'lucide-react'
import { getApiUrl } from '../utils/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const isLocalOnly = process.env.NEXT_PUBLIC_LOCAL_ONLY === 'true'

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const url = isLocalOnly ? getApiUrl('/api/auth/login') : '/api/auth/login'
      const payload = isLocalOnly ? { password } : { email, password }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (res.status === 200) {
        const data = await res.json()
        localStorage.setItem('admin_token', data.token)
        document.cookie = `admin_token=${data.token}; path=/; max-age=604800; SameSite=Strict`;

        // Senha de fabrica: a API bloqueia o resto do sistema ate a troca.
        if (data.must_change_password) {
          window.location.href = '/change-password'
          return
        }

        window.location.href = isLocalOnly ? '/' : '/dashboard'
      } else {
        // A API do appliance (FastAPI) responde em `detail`; a da nuvem
        // (route handler do Next) responde em `error`.
        const errData = await res.json()
        setError(errData.detail || errData.error || 'Falha na autenticação.')
      }
    } catch (err) {
      setError('Erro de rede. Verifique se o servidor está ativo.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center p-6 z-50">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-blue-900/10 via-slate-950 to-slate-950 pointer-events-none" />
      
      <div className="w-full max-w-md bg-slate-900/50 border border-slate-800 backdrop-blur-md rounded-[2.5rem] p-10 space-y-8 shadow-2xl relative">
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="bg-blue-600 p-4 rounded-3xl shadow-xl shadow-blue-500/20">
            <Shield size={36} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white uppercase tracking-tighter">VISIONCAM <span className="text-blue-500">GATEWAY</span></h1>
            <p className="text-slate-500 text-xs mt-1 font-medium">
              {isLocalOnly ? 'Console técnico local — Acesso Restrito' : 'Central de Gerência na Nuvem'}
            </p>
          </div>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          {!isLocalOnly && (
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block ml-1">Endereço de E-mail</label>
              <div className="relative">
                <input 
                  type="email"
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-5 py-4 text-sm text-white focus:border-blue-500/50 outline-none transition-all"
                  placeholder="seu-usuario@cliente.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
                <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block ml-1">
              {isLocalOnly ? 'Senha de Administrador' : 'Senha de Acesso'}
            </label>
            <div className="relative">
              <input 
                type="password"
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-5 py-4 text-sm text-white focus:border-blue-500/50 outline-none transition-all font-mono"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <Key size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" />
            </div>
          </div>

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl p-4 text-center font-medium">
              {error}
            </div>
          )}

          <button 
            type="submit"
            disabled={isLoading}
            className="w-full py-4 bg-white hover:bg-blue-600 hover:text-white text-slate-950 font-black text-xs uppercase tracking-[0.2em] rounded-2xl shadow-xl transition-all flex items-center justify-center gap-3"
          >
            {isLoading ? <Loader2 className="animate-spin" size={18} /> : null}
            Entrar no Sistema
          </button>
        </form>

        <div className="text-center text-[10px] text-slate-600 font-mono uppercase tracking-widest pt-2">
          {isLocalOnly ? 'Node-ID: Cubie-A7A' : 'VisionCam Cloud'}
        </div>
      </div>
    </div>
  )
}
