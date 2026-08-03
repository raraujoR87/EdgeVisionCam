"use client"
import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { Shield, LayoutDashboard, Target, Settings, LogOut, Loader2, Server, Store, BarChart3, Building2, ScrollText } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { getApiUrl } from './utils/api'

interface UserSession {
  email: string;
  role: string;
  store_id: number | null;
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLoginPage = pathname === '/login'
  // Telas que se desenham sozinhas, fora do chrome do console.
  const isChangePasswordPage = pathname === '/change-password'
  // O console do cliente traz o próprio chrome (navegação, seletor de
  // organização, barra inferior no celular). Empilhar as duas barras laterais
  // sobraria 100px de conteúdo no notebook.
  const isConsolePage = pathname.startsWith('/console')
  const isStandalonePage = isLoginPage || isChangePasswordPage || isConsolePage
  const [user, setUser] = useState<UserSession | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const isCloudMode = process.env.NEXT_PUBLIC_LOCAL_ONLY !== 'true'

  useEffect(() => {
    if (isLoginPage) {
      setIsLoading(false)
      return
    }

    const token = localStorage.getItem('admin_token')
    // A tela de troca precisa do token para chamar change-password, mas nao
    // deve exigir que o resto da API esteja liberado.
    if (isChangePasswordPage && token) {
      setIsLoading(false)
      return
    }
    if (!token) {
      setIsAuthenticated(false)
      setIsLoading(false)
      window.location.href = '/login'
    } else {
      // Validar sessão de forma unificada (local ou Supabase na nuvem)
      const verifyUrl = isCloudMode ? '/api/auth/verify' : getApiUrl('/api/auth/verify')
      fetch(verifyUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => {
        if (res.ok) {
          return res.json()
        }
        throw new Error('Sessão inválida')
      })
      .then(data => {
        // Senha de fabrica em uso: a API recusa todo o resto com 403, entao
        // nao adianta renderizar o console.
        if (data.must_change_password && !isChangePasswordPage) {
          window.location.href = '/change-password'
          return
        }
        setIsAuthenticated(true)
        setUser(data.user)
      })
      .catch(() => {
        localStorage.removeItem('admin_token')
        setIsAuthenticated(false)
        window.location.href = '/login'
      })
      .finally(() => {
        setIsLoading(false)
      })
    }
  }, [pathname, isLoginPage, isChangePasswordPage])

  // Encaminhamento por perfil.
  //
  // A versão anterior mantinha uma lista escrita à mão dos caminhos proibidos
  // ao cliente. Toda tela nova do fornecedor precisava ser lembrada nessa
  // lista, e uma esquecida ficava acessível — o modo de falha era abrir demais.
  //
  // Aqui a regra é invertida: quem é cliente vive em /console, e qualquer outro
  // caminho o traz de volta. Uma tela nova do fornecedor nasce fora do alcance
  // dele sem ninguém precisar lembrar de nada.
  useEffect(() => {
    if (!user) return

    const ehFornecedor = ['admin', 'SUPER_ADMIN'].includes(user.role)

    if (!ehFornecedor && !isConsolePage) {
      window.location.href = '/console'
      return
    }
    if (ehFornecedor && pathname === '/') {
      window.location.href = '/dashboard'
    }
  }, [user, pathname, isConsolePage])

  const handleLogout = () => {
    localStorage.removeItem('admin_token')
    document.cookie = "admin_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    window.location.href = '/login'
  }

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-slate-950 flex items-center justify-center">
        <Loader2 className="animate-spin text-blue-500" size={32} />
      </div>
    )
  }

  if (isStandalonePage) {
    return <>{children}</>
  }

  return (
    <div className="pl-64 min-h-screen bg-slate-950 text-slate-100">
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-screen fixed left-0 top-0 z-45">
        <div className="p-6 flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg">
            <Shield size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">VisionCam</h1>
        </div>
        
        <nav className="flex-1 px-4 space-y-2 mt-4">
          {user && ['SUPER_ADMIN', 'admin'].includes(user.role) && isCloudMode ? (
            // Sidebar para Administradores da Nuvem (Equipe Interna)
            <>
              <Link href="/dashboard" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/dashboard' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <LayoutDashboard size={20} />
                <span className="font-medium">Painel Central</span>
              </Link>
              <Link href="/dashboard/organizations" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/dashboard/organizations' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <Building2 size={20} />
                <span className="font-medium">Clientes</span>
              </Link>
              <Link href="/dashboard/stores" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/dashboard/stores' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <Store size={20} />
                <span className="font-medium">Lojas</span>
              </Link>
              <Link href="/dashboard/deploys" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/dashboard/deploys' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <Server size={20} />
                <span className="font-medium">Frota & Deploys</span>
              </Link>
              <Link href="/dashboard/events" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/dashboard/events' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <Shield size={20} />
                <span className="font-medium">Eventos</span>
              </Link>
              <Link href="/dashboard/audit" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/dashboard/audit' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <ScrollText size={20} />
                <span className="font-medium">Auditoria</span>
              </Link>
              {/* O fornecedor precisa conseguir ver o produto como o cliente vê
                  — é onde se reproduz o que o cliente relata no suporte. */}
              <Link href="/console" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-500 hover:bg-slate-800 hover:text-sky-300 transition-colors mt-2 border-t border-slate-800/60 pt-4">
                <BarChart3 size={20} />
                <span className="font-medium">Console do cliente</span>
              </Link>
            </>
          ) : !isCloudMode ? (
            // Sidebar para Técnico Local (Borda)
            <>
              <Link href="/setup" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/setup' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <Target size={20} />
                <span className="font-medium">Zone Setup</span>
              </Link>
              <Link href="/settings" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/settings' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                <Settings size={20} />
                <span className="font-medium">Engine Room</span>
              </Link>
            </>
          ) : null}
        </nav>

        <div className="px-4 py-2 border-t border-slate-800/60">
          <button 
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 hover:bg-rose-950/20 hover:text-rose-400 rounded-xl transition-colors"
          >
            <LogOut size={20} />
            <span className="font-medium">Sair do Console</span>
          </button>
        </div>

        <div className="p-4 text-xs font-mono text-slate-600 text-center border-t border-slate-800/60 font-semibold">
          {isCloudMode ? "Console do fornecedor" : "Edge Node Online"}
        </div>
      </aside>

      <main className="p-8">
        {children}
      </main>
    </div>
  )
}
