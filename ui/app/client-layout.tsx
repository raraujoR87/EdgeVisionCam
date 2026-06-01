"use client"
import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { Shield, LayoutDashboard, Target, Settings, LogOut, Loader2 } from 'lucide-react'
import { usePathname } from 'next/navigation'

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLoginPage = pathname === '/login'
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('admin_token')
    if (!token) {
      setIsAuthenticated(false)
      setIsLoading(false)
      if (!isLoginPage) {
        window.location.href = '/login'
      }
    } else {
      // Validate token with backend
      fetch('http://localhost:8000/api/auth/verify', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => {
        if (res.status === 200) {
          setIsAuthenticated(true)
        } else {
          localStorage.removeItem('admin_token')
          setIsAuthenticated(false)
          if (!isLoginPage) {
            window.location.href = '/login'
          }
        }
      })
      .catch(() => {
        // If server is offline but token is present, we still allow local cached view,
        // so setup is not blocked if backend API crashes temporarily.
        setIsAuthenticated(true)
      })
      .finally(() => {
        setIsLoading(false)
      })
    }
  }, [pathname, isLoginPage])

  const handleLogout = () => {
    localStorage.removeItem('admin_token')
    window.location.href = '/login'
  }

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-slate-950 flex items-center justify-center">
        <Loader2 className="animate-spin text-blue-500" size={32} />
      </div>
    )
  }

  if (isLoginPage) {
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
          <Link href="/" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <LayoutDashboard size={20} />
            <span className="font-medium">Overview</span>
          </Link>
          <Link href="/setup" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/setup' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <Target size={20} />
            <span className="font-medium">Zone Setup</span>
          </Link>
          <Link href="/settings" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${pathname === '/settings' ? 'bg-slate-800 text-white font-bold' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <Settings size={20} />
            <span className="font-medium">Engine Room</span>
          </Link>
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

        <div className="p-4 text-xs font-mono text-slate-600 text-center border-t border-slate-800/60">
          Edge Node Online
        </div>
      </aside>

      <main className="p-8">
        {children}
      </main>
    </div>
  )
}
