"use client"
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Save, RotateCcw, Wifi, WifiOff, Trash2, Power, BarChart3, Shield, Loader2, Edit3, Maximize2, AlertCircle, ScanEye } from 'lucide-react'
import useSWR from 'swr'

const apiFetch = (url: string, options: RequestInit = {}) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('admin_token') : null
  const headers = {
    ...options.headers,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  }
  return fetch(url, { ...options, headers }).then(res => {
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('admin_token')
      window.location.href = '/login'
    }
    return res
  })
}

const fetcher = (url: string) => apiFetch(url).then(res => res.json())

// Component to suppress 3rd party extension errors
class SafeCanvas extends React.Component<{ children: React.ReactNode }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) return <div className="p-4 bg-rose-500/10 text-rose-500 rounded-xl">Hardware rendering interrupted by browser extension.</div>
    return this.props.children
  }
}

export default function ZoneSetup() {
  const [points, setPoints] = useState<{x: number, y: number}[]>([])
  const [zoneName, setZoneName] = useState('')
  const [apiOnline, setApiOnline] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  
  const canvasRef = useRef<HTMLCanvasElement>(null)
  
  const { data: zones, mutate } = useSWR('http://localhost:8000/api/zones', fetcher, { refreshInterval: 2000 })
  const { data: engineStatus } = useSWR('http://localhost:8000/api/engine/status', fetcher, { refreshInterval: 1000 })
  const engineOnline = engineStatus?.online || false

  useEffect(() => {
    const check = async () => {
      try {
        const res = await apiFetch('http://localhost:8000/api/telemetry')
        setApiOnline(res.ok)
      } catch { setApiOnline(false) }
    }
    check(); const interval = setInterval(check, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = 640 / rect.width
    const scaleY = 480 / rect.height
    const x = Math.round((e.clientX - rect.left) * scaleX)
    const y = Math.round((e.clientY - rect.top) * scaleY)
    setPoints(prev => [...prev, { x, y }])
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (points.length === 0) return
    
    ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.moveTo(points[0].x, points[0].y)
    points.forEach(p => ctx.lineTo(p.x, p.y))
    ctx.closePath()
    ctx.fillStyle = 'rgba(79, 70, 229, 0.2)'; ctx.fill()
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.stroke()
    ctx.setLineDash([])
    
    points.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#fbbf24' : '#fff'; ctx.fill()
      ctx.shadowBlur = 10; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.stroke()
    })
  }, [points])

  useEffect(() => { draw() }, [draw])

  const saveZone = async () => {
    if (points.length < 3 || !zoneName) return
    setIsSaving(true)
    try {
      await apiFetch('http://localhost:8000/api/zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: zoneName, polygon: points })
      })
      setPoints([]); setZoneName(''); mutate()
    } catch (err) { console.error(err) } finally { setIsSaving(false) }
  }

  return (
    <div className="flex flex-col space-y-8 animate-in fade-in duration-700 pb-20">
      {/* Dynamic Navbar */}
      <header className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-slate-900/50 backdrop-blur-xl p-8 rounded-[2.5rem] border border-white/5 ring-1 ring-white/5 shadow-2xl">
        <div className="flex items-center gap-5">
           <div className="bg-indigo-600 p-4 rounded-3xl shadow-lg shadow-indigo-500/20">
              <ScanEye size={32} className="text-white" />
           </div>
           <div>
              <h1 className="text-3xl font-black tracking-tighter text-white uppercase italic">Sentinel <span className="text-indigo-400">Calibration</span></h1>
              <p className="text-slate-500 text-xs font-bold uppercase tracking-[0.3em] mt-1">Spatial Perimeter Mapping Node</p>
           </div>
        </div>
        <div className={`flex items-center gap-3 px-6 py-3 rounded-2xl text-[10px] font-black tracking-[0.2em] border transition-all ${apiOnline ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-500'}`}>
          <div className={`w-2 h-2 rounded-full ${apiOnline ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
          {apiOnline ? 'LINK ESTABLISHED' : 'SYSTEM OFFLINE'}
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
        {/* Main Interface */}
        <div className="xl:col-span-8 space-y-6">
          <div className="group relative aspect-video bg-black rounded-[3rem] overflow-hidden border-4 border-slate-800/50 shadow-[0_0_100px_-12px_rgba(0,0,0,0.8)] ring-1 ring-white/10">
             {engineOnline ? (
               <img src="http://localhost:8000/video_feed" alt="Stream" className="w-full h-full object-fill opacity-90 transition-opacity group-hover:opacity-100 animate-in fade-in duration-700" />
             ) : (
               <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 gap-4 text-center">
                 <Loader2 className="animate-spin text-indigo-500" size={48} />
                 <div className="space-y-1">
                   <div className="text-white text-sm font-black uppercase tracking-widest animate-pulse">Initializing Biomechanical Vision Engine</div>
                   <div className="text-slate-500 text-xs font-bold uppercase tracking-[0.2em]">Synchronizing neural layers & poses...</div>
                 </div>
               </div>
             )}
             
             <SafeCanvas>
                <canvas ref={canvasRef} width={640} height={480} onClick={handleCanvasClick} className="absolute inset-0 w-full h-full cursor-crosshair z-10" />
             </SafeCanvas>

             {/* UI Glass Panel */}
             <div className="absolute inset-x-8 bottom-8 flex flex-wrap gap-4 bg-slate-950/40 backdrop-blur-2xl p-5 rounded-[2rem] border border-white/10 z-20 shadow-2xl translate-y-4 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-500">
                <div className="flex-1 min-w-[260px] flex items-center gap-3 bg-white/5 border border-white/5 rounded-2xl px-6 focus-within:ring-2 focus-within:ring-indigo-500 transition-all">
                   <Edit3 size={18} className="text-slate-500" />
                   <input 
                      placeholder="Define Zone Label..." 
                      value={zoneName} 
                      onChange={e => setZoneName(e.target.value)} 
                      className="bg-transparent w-full py-4 text-white text-sm font-bold outline-none placeholder:text-slate-600" 
                   />
                </div>
                <button 
                   onClick={saveZone} 
                   disabled={isSaving || points.length < 3}
                   className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 px-10 py-4 rounded-2xl text-xs font-black text-white uppercase tracking-widest transition-all shadow-xl flex items-center gap-3"
                >
                  {isSaving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                  Commence Sentinel
                </button>
                <button onClick={() => setPoints([])} className="bg-white/10 hover:bg-white/20 text-white p-4 rounded-2xl transition-all"><RotateCcw size={20}/></button>
             </div>

             {/* Static Badges */}
             <div className="absolute top-8 left-8 pointer-events-none space-y-3">
                <div className="bg-indigo-600/90 backdrop-blur-md px-5 py-2.5 rounded-2xl border border-white/10 flex items-center gap-3 shadow-xl">
                   <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                   <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">640x480 Unified Grid</span>
                </div>
                {points.length > 0 && (
                   <div className="bg-slate-900/80 backdrop-blur-md px-5 py-2.5 rounded-2xl border border-white/10 text-[10px] font-black text-indigo-400 uppercase tracking-[0.2em] inline-block ml-2">
                      Vertices: {points.length}
                   </div>
                )}
             </div>
          </div>
          
          <div className="flex items-center gap-4 bg-indigo-500/5 p-6 rounded-3xl border border-indigo-500/10">
             <AlertCircle className="text-indigo-400 shrink-0" size={24} />
             <p className="text-slate-400 text-sm leading-relaxed font-medium">
                <strong className="text-indigo-400">Protocol:</strong> Click on the visual feed to establish perimeter boundaries. The AI node will exclusively monitor biological kinetics within these designated regions.
             </p>
          </div>
        </div>

        {/* Sidebar Inventory */}
        <div className="xl:col-span-4 h-full">
          <div className="bg-slate-900/30 border border-white/5 backdrop-blur-xl rounded-[3rem] p-8 h-full flex flex-col shadow-2xl ring-1 ring-white/5">
            <div className="flex items-center justify-between mb-10">
               <h2 className="text-xl font-black text-white uppercase tracking-tighter italic">Active Inventory</h2>
               <div className="bg-indigo-500/20 text-indigo-400 px-4 py-1.5 rounded-xl text-[10px] font-black tracking-widest">{zones?.length || 0} NODES</div>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-5 pr-2 custom-scrollbar">
              {zones?.map((z: any) => (
                <div key={z.id} className={`group relative p-7 rounded-[2rem] border-2 transition-all duration-500 hover:scale-[1.02] ${z.is_active ? 'bg-slate-800/40 border-indigo-500/30 shadow-indigo-500/10 shadow-2xl' : 'bg-slate-950/20 border-white/5 opacity-40 grayscale hover:opacity-100 hover:grayscale-0'}`}>
                  <div className="flex justify-between items-start">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                         <div className={`w-3 h-3 rounded-full ${z.is_active ? 'bg-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.8)]' : 'bg-slate-700'}`} />
                         <h3 className="font-black text-white text-base uppercase tracking-tight leading-none">{z.name}</h3>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="flex items-center gap-2">
                           <BarChart3 size={18} className="text-indigo-500" />
                           <span className="text-sm text-slate-300 font-black tracking-tighter">{z.trigger_count}</span>
                           <span className="text-[9px] text-slate-500 font-bold uppercase ml-1">Alerts</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-x-4 group-hover:translate-x-0">
                      <button onClick={async () => { await apiFetch(`http://localhost:8000/api/zones/${z.id}/toggle`, { method: 'PATCH' }); mutate() }} className={`p-3 rounded-2xl transition-all shadow-lg ${z.is_active ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-500 border border-white/5'}`}>
                        <Power size={18} />
                      </button>
                      <button onClick={async () => { if(confirm("Terminate node?")) { await apiFetch(`http://localhost:8000/api/zones/${z.id}`, { method: 'DELETE' }); mutate() } }} className="p-3 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-2xl hover:bg-rose-500/20 transition-all shadow-lg">
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              
              {(!zones || zones.length === 0) && (
                <div className="py-24 text-center flex flex-col items-center justify-center space-y-6 border-4 border-dashed border-white/5 rounded-[3.5rem] opacity-30">
                   <Shield size={64} className="text-slate-600" />
                   <p className="text-xs font-black text-slate-600 uppercase tracking-[0.3em]">No Sentinel Units Online</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
