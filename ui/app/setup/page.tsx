"use client"
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Save, RotateCcw, Trash2, Power, BarChart3, Shield, Loader2, Edit3, AlertCircle, ScanEye, Camera, Plus, Settings } from 'lucide-react'
import useSWR from 'swr'
import { getApiUrl } from '../utils/api'

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
  
  // Data Fetching
  const { data: zones, mutate } = useSWR(getApiUrl('/api/zones'), fetcher, { refreshInterval: 2000 })
  const { data: engineStatus } = useSWR(getApiUrl('/api/engine/status'), fetcher, { refreshInterval: 1000 })
  const engineOnline = engineStatus?.online || false

  // Cameras Config & Setup
  const { data: cameras, mutate: mutateCameras } = useSWR(getApiUrl('/api/cameras'), fetcher, { refreshInterval: 3000 })
  const [selectedCameraName, setSelectedCameraName] = useState('camera_principal')
  const [newCamName, setNewCamName] = useState('')
  const [newCamRtsp, setNewCamRtsp] = useState('')
  const [isSavingCam, setIsSavingCam] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'zones' | 'cameras'>('zones')

  useEffect(() => {
    const check = async () => {
      try {
        const res = await apiFetch(getApiUrl('/api/telemetry'))
        setApiOnline(res.ok)
      } catch { setApiOnline(false) }
    }
    check(); const interval = setInterval(check, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (cameras && cameras.length > 0) {
      const exists = cameras.some((c: any) => c.name === selectedCameraName)
      if (!exists) {
        setSelectedCameraName(cameras[0].name)
      }
    }
  }, [cameras, selectedCameraName])

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = 640 / rect.width
    const scaleY = 480 / rect.height
    const x = Math.round((e.clientX - rect.left) * scaleX)
    const y = Math.round((e.clientY - rect.top) * scaleY)
    setPoints(prev => [...prev, { x, y }])
  }

  const filteredZones = zones?.filter((z: any) => z.camera_name === selectedCameraName) || []

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Draw saved zones
    filteredZones.forEach((z: any) => {
      try {
        const pts = typeof z.points_json === 'string' ? JSON.parse(z.points_json) : z.polygon;
        if (!pts || pts.length < 3) return;
        
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        pts.forEach((p: any) => ctx.lineTo(p.x, p.y))
        ctx.closePath()
        
        if (z.is_active) {
          ctx.fillStyle = 'rgba(79, 70, 229, 0.15)' // indigo
          ctx.strokeStyle = '#818cf8'
        } else {
          ctx.fillStyle = 'rgba(100, 116, 139, 0.15)' // slate
          ctx.strokeStyle = '#94a3b8'
        }
        ctx.fill()
        ctx.lineWidth = 2; ctx.stroke()
        
        // Draw zone name
        ctx.font = '12px Inter, sans-serif'
        ctx.fillStyle = z.is_active ? '#c7d2fe' : '#cbd5e1'
        ctx.fillText(z.name.toUpperCase(), pts[0].x + 10, pts[0].y + 15)
      } catch (e) {
        // Skip invalid polygons
      }
    })

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
  }, [points, filteredZones])

  useEffect(() => { draw() }, [draw])

  const saveZone = async () => {
    if (points.length < 3 || !zoneName) return
    setIsSaving(true)
    try {
      await apiFetch(getApiUrl('/api/zones'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: zoneName, polygon: points, camera_name: selectedCameraName })
      })
      setPoints([]); setZoneName(''); mutate()
    } catch (err) { console.error(err) } finally { setIsSaving(false) }
  }

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCamName || !newCamRtsp) return
    setIsSavingCam(true)
    try {
      const res = await apiFetch(getApiUrl('/api/cameras'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCamName, rtsp_url: newCamRtsp, is_active: true })
      })
      if (!res.ok) {
        const data = await res.json()
        alert(data.detail || "Failed to add camera")
      } else {
        setNewCamName('')
        setNewCamRtsp('')
        mutateCameras()
      }
    } catch (err) {
      console.error(err)
    } finally {
      setIsSavingCam(false)
    }
  }

  const handleDeleteCamera = async (id: number) => {
    if (!confirm("Remove this camera feed? Frigate NVR will restart to apply changes.")) return
    try {
      await apiFetch(getApiUrl(`/api/cameras/${id}`), { method: 'DELETE' })
      mutateCameras()
      if (cameras && cameras.length > 1) {
        const remaining = cameras.filter((c: any) => c.id !== id)
        if (remaining.length > 0) {
          setSelectedCameraName(remaining[0].name)
        }
      }
    } catch (err) {
      console.error(err)
    }
  }

  const getStreamUrl = () => {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      return `http://${hostname}:5000/api/${selectedCameraName}`;
    }
    return '';
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

      {/* Camera switcher panel above stream */}
      {cameras && cameras.length > 0 && (
        <div className="flex flex-wrap items-center justify-between bg-slate-900/40 backdrop-blur-md p-6 rounded-[2rem] border border-white/5 shadow-xl gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/10 p-3 rounded-xl border border-indigo-500/20">
              <Camera size={20} className="text-indigo-400" />
            </div>
            <div>
              <div className="text-sm font-black text-white uppercase tracking-wider">Active Calibration Feed</div>
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Switch stream to configure coordinates</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {cameras.map((c: any) => (
              <button
                key={c.id}
                onClick={() => {
                  setSelectedCameraName(c.name)
                  setPoints([])
                }}
                className={`px-5 py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all border ${
                  selectedCameraName === c.name
                    ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-500/25 scale-[1.02]'
                    : 'bg-slate-950/40 border-white/5 text-slate-400 hover:bg-white/5 hover:text-white hover:scale-[1.01]'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
        {/* Main Interface */}
        <div className="xl:col-span-8 space-y-6">
          <div className="group relative aspect-video bg-black rounded-[3rem] overflow-hidden border-4 border-slate-800/50 shadow-[0_0_100px_-12px_rgba(0,0,0,0.8)] ring-1 ring-white/10">
             {apiOnline ? (
               <img 
                 src={getStreamUrl()} 
                 alt="Stream" 
                 className="w-full h-full object-fill opacity-90 transition-opacity group-hover:opacity-100 animate-in fade-in duration-700" 
                 onError={(e) => {
                   // Fallback para o MJPEG da engine quando o Frigate nao responde.
                   // A tag <img> nao envia headers, entao o token vai na query
                   // string — o unico endpoint que aceita essa forma.
                   const t = localStorage.getItem('admin_token') || '';
                   (e.target as HTMLImageElement).src = getApiUrl(`/video_feed?token=${encodeURIComponent(t)}`);
                 }}
               />
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
                   <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">640x480 Unified Grid ({selectedCameraName})</span>
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
                <strong className="text-indigo-400">Protocol:</strong> Click on the visual feed to establish perimeter boundaries. The AI node will exclusively monitor biological kinetics within these designated regions for the selected camera.
             </p>
          </div>
        </div>

        {/* Sidebar Inventory with Tab System */}
        <div className="xl:col-span-4 h-full">
          <div className="bg-slate-900/30 border border-white/5 backdrop-blur-xl rounded-[3rem] p-8 h-full flex flex-col shadow-2xl ring-1 ring-white/5">
            {/* Tabs selector */}
            <div className="flex bg-slate-950/60 p-1.5 rounded-2xl border border-white/5 mb-8">
              <button
                type="button"
                onClick={() => setSidebarTab('zones')}
                className={`flex-1 py-3 text-xs font-black uppercase tracking-wider rounded-xl transition-all ${
                  sidebarTab === 'zones' 
                    ? 'bg-slate-800 text-white shadow-md' 
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Zones
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('cameras')}
                className={`flex-1 py-3 text-xs font-black uppercase tracking-wider rounded-xl transition-all ${
                  sidebarTab === 'cameras' 
                    ? 'bg-slate-800 text-white shadow-md' 
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Cameras
              </button>
            </div>

            {sidebarTab === 'zones' ? (
              // Tab 1: Guard Zones Inventory
              <>
                <div className="flex items-center justify-between mb-8">
                   <h2 className="text-lg font-black text-white uppercase tracking-tighter italic">Active Inventory</h2>
                   <div className="bg-indigo-500/20 text-indigo-400 px-4 py-1.5 rounded-xl text-[10px] font-black tracking-widest">{filteredZones.length} NODES</div>
                </div>
                
                <div className="flex-1 overflow-y-auto space-y-5 pr-2 custom-scrollbar">
                  {filteredZones.map((z: any) => (
                    <div key={z.id} className={`group relative p-6 rounded-[2rem] border-2 transition-all duration-500 hover:scale-[1.02] ${z.is_active ? 'bg-slate-800/40 border-indigo-500/30 shadow-indigo-500/10 shadow-2xl' : 'bg-slate-950/20 border-white/5 opacity-40 grayscale hover:opacity-100 hover:grayscale-0'}`}>
                      <div className="flex justify-between items-start">
                        <div className="space-y-3">
                          <div className="flex items-center gap-3">
                             <div className={`w-3 h-3 rounded-full ${z.is_active ? 'bg-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.8)]' : 'bg-slate-700'}`} />
                             <h3 className="font-black text-white text-sm uppercase tracking-tight leading-none">{z.name}</h3>
                          </div>
                          <div className="flex items-center gap-2">
                             <BarChart3 size={16} className="text-indigo-500" />
                             <span className="text-xs text-slate-300 font-black tracking-tighter">{z.trigger_count}</span>
                             <span className="text-[9px] text-slate-500 font-bold uppercase ml-1">Alerts</span>
                          </div>
                        </div>
                        
                        <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-x-4 group-hover:translate-x-0">
                          <button onClick={async () => { await apiFetch(getApiUrl(`/api/zones/${z.id}/toggle`), { method: 'PATCH' }); mutate() }} className={`p-2.5 rounded-xl transition-all shadow-lg ${z.is_active ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-500 border border-white/5'}`}>
                            <Power size={14} />
                          </button>
                          <button onClick={async () => { if(confirm("Terminate node?")) { await apiFetch(getApiUrl(`/api/zones/${z.id}`), { method: 'DELETE' }); mutate() } }} className="p-2.5 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-xl hover:bg-rose-500/20 transition-all shadow-lg">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  
                  {filteredZones.length === 0 && (
                    <div className="py-20 text-center flex flex-col items-center justify-center space-y-6 border-4 border-dashed border-white/5 rounded-[3rem] opacity-30">
                       <Shield size={48} className="text-slate-600" />
                       <p className="text-[10px] font-black text-slate-600 uppercase tracking-[0.3em]">No Zones calibrated on this feed</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              // Tab 2: Cameras Configuration Setup
              <>
                <div className="flex items-center justify-between mb-8">
                   <h2 className="text-lg font-black text-white uppercase tracking-tighter italic">Cameras List</h2>
                   <div className="bg-indigo-500/20 text-indigo-400 px-4 py-1.5 rounded-xl text-[10px] font-black tracking-widest">{cameras?.length || 0}/4 NODES</div>
                </div>

                <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                  {cameras?.map((c: any) => (
                    <div key={c.id} className="group relative p-5 bg-slate-950/40 rounded-[2rem] border border-white/5 flex items-center justify-between hover:border-white/10 transition-all">
                      <div className="space-y-1 overflow-hidden pr-2">
                        <div className="text-sm font-black text-white uppercase truncate">{c.name}</div>
                        <div className="text-[9px] font-mono text-slate-500 truncate">{c.rtsp_url}</div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {cameras.length > 1 && (
                          <button 
                            onClick={() => handleDeleteCamera(c.id)}
                            className="p-2.5 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-xl hover:bg-rose-500/20 transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Add Camera Form */}
                  {(!cameras || cameras.length < 4) && (
                    <form onSubmit={handleAddCamera} className="mt-6 p-6 bg-slate-900/60 rounded-[2rem] border border-white/5 space-y-4">
                      <div className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                        <Plus size={14} /> Register Camera
                      </div>
                      
                      <div className="space-y-3">
                        <div>
                          <input 
                            placeholder="Camera Name (e.g. corredor_1)" 
                            value={newCamName}
                            onChange={e => setNewCamName(e.target.value)}
                            required
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-indigo-500 transition-all"
                          />
                        </div>
                        <div>
                          <input 
                            placeholder="RTSP Feed URL" 
                            value={newCamRtsp}
                            onChange={e => setNewCamRtsp(e.target.value)}
                            required
                            className="w-full bg-slate-950 border border-white/5 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-indigo-500 transition-all font-mono"
                          />
                        </div>
                      </div>

                      <button 
                        type="submit"
                        disabled={isSavingCam}
                        className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-white transition-all shadow-md flex items-center justify-center gap-2"
                      >
                        {isSavingCam ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
                        Save to NVR Stack
                      </button>
                    </form>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
