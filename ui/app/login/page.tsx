"use client"
import React, { useState } from 'react'
import { Shield, Key, Loader2 } from 'lucide-react'

export default function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const res = await fetch('http://localhost:8000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })

      if (res.status === 200) {
        const data = await res.json()
        localStorage.setItem('admin_token', data.token)
        window.location.href = '/'
      } else {
        const errData = await res.json()
        setError(errData.detail || 'Senha incorreta.')
      }
    } catch (err) {
      setError('Erro de rede. Verifique se o backend está ativo.')
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
            <p className="text-slate-500 text-xs mt-1 font-medium">Console técnico local — Acesso Restrito</p>
          </div>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block ml-1">Senha de Administrador</label>
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
          Node-ID: Cubie-A7A
        </div>
      </div>
    </div>
  )
}
