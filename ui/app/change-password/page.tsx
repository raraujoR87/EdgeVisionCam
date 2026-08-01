"use client"
import React, { useState } from 'react'
import { Shield, Key, Loader2, AlertTriangle } from 'lucide-react'
import { getApiUrl } from '../utils/api'

/**
 * Troca obrigatoria da senha de fabrica.
 *
 * Enquanto `password_is_default` estiver ativo, a API responde 403 em todos os
 * endpoints exceto este fluxo — o appliance so comeca a operar depois da troca.
 * Esta tela e a face desse bloqueio, nao o bloqueio em si.
 */
export default function ChangePassword() {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (newPassword !== confirmPassword) {
      setError('A confirmação não confere com a nova senha.')
      return
    }
    if (newPassword.length < 8) {
      setError('A nova senha deve ter ao menos 8 caracteres.')
      return
    }
    if (newPassword === oldPassword) {
      setError('A nova senha precisa ser diferente da atual.')
      return
    }

    setIsLoading(true)
    try {
      const token = localStorage.getItem('admin_token')
      const res = await fetch(getApiUrl('/api/auth/change-password'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      })

      if (res.ok) {
        // A senha mudou, entao a sessao atual precisa ser refeita com ela.
        localStorage.removeItem('admin_token')
        document.cookie = 'admin_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
        window.location.href = '/login'
        return
      }

      const data = await res.json()
      setError(data.detail || 'Não foi possível trocar a senha.')
    } catch {
      setError('Erro de rede. Verifique se o servidor está ativo.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center p-6 z-50 overflow-y-auto">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-amber-900/10 via-slate-950 to-slate-950 pointer-events-none" />

      <div className="w-full max-w-md bg-slate-900/50 border border-slate-800 backdrop-blur-md rounded-[2.5rem] p-10 space-y-8 shadow-2xl relative my-auto">
        <div className="flex flex-col items-center text-center space-y-4">
          <div className="bg-amber-600 p-4 rounded-3xl shadow-xl shadow-amber-500/20">
            <Shield size={36} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white uppercase tracking-tighter">
              TROCA <span className="text-amber-500">OBRIGATÓRIA</span>
            </h1>
            <p className="text-slate-500 text-xs mt-1 font-medium">
              Defina a senha antes de liberar o console
            </p>
          </div>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex gap-3">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-amber-200/80 text-xs leading-relaxed">
            Este appliance ainda usa a senha de fábrica, que é pública. Enquanto
            ela não for trocada, nenhuma câmera, zona ou evento fica acessível.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {[
            { label: 'Senha atual', value: oldPassword, set: setOldPassword, ph: '••••••••' },
            { label: 'Nova senha', value: newPassword, set: setNewPassword, ph: 'Mínimo 8 caracteres' },
            { label: 'Confirmar nova senha', value: confirmPassword, set: setConfirmPassword, ph: 'Repita a nova senha' },
          ].map((field) => (
            <div className="space-y-2" key={field.label}>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block ml-1">
                {field.label}
              </label>
              <div className="relative">
                <input
                  type="password"
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-5 py-4 text-sm text-white focus:border-amber-500/50 outline-none transition-all font-mono"
                  placeholder={field.ph}
                  value={field.value}
                  onChange={(e) => field.set(e.target.value)}
                  required
                />
                <Key size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" />
              </div>
            </div>
          ))}

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl p-4 text-center font-medium">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-4 bg-white hover:bg-amber-600 hover:text-white text-slate-950 font-black text-xs uppercase tracking-[0.2em] rounded-2xl shadow-xl transition-all flex items-center justify-center gap-3 disabled:opacity-60"
          >
            {isLoading ? <Loader2 className="animate-spin" size={18} /> : null}
            Definir nova senha
          </button>
        </form>
      </div>
    </div>
  )
}
