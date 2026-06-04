"use client"
import React, { useState, useEffect } from 'react'
import { Save, ShieldCheck, Key, MessageSquare, BrainCircuit, Loader2, CheckCircle2, MapPin, Camera } from 'lucide-react'
import useSWR from 'swr'
import { getApiUrl } from '../utils/api'

const fetcher = (url: string) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('admin_token') : null
  return fetch(url, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  }).then(res => {
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('admin_token')
      window.location.href = '/login'
    }
    return res.json()
  })
}

export default function EngineRoom() {
  const [geminiKey, setGeminiKey] = useState('')
  const [telegramToken, setTelegramToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [brainRules, setBrainRules] = useState('')
  const [cameraName, setCameraName] = useState('')
  const [routeLeft, setRouteLeft] = useState('')
  const [routeRight, setRouteRight] = useState('')
  const [modelSource, setModelSource] = useState('hybrid')
  const [enableFallback, setEnableFallback] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  const { data: config, mutate } = useSWR(getApiUrl('/api/config'), fetcher)

  // Load existing config into state
  useEffect(() => {
    if (config) {
      setGeminiKey(config.gemini_api_key || '')
      setTelegramToken(config.telegram_bot_token || '')
      setChatId(config.telegram_chat_id || '')
      setBrainRules(config.brain_rules || '')
      setCameraName(config.camera_name || '')
      setRouteLeft(config.route_left || '')
      setRouteRight(config.route_right || '')
      setModelSource(config.model_source || 'hybrid')
      setEnableFallback(config.enable_fallback === 'true')
    }
  }, [config])

  const saveConfig = async (key: string, value: string) => {
    const token = localStorage.getItem('admin_token')
    await fetch(getApiUrl('/api/config'), {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ key, value })
    })
  }

  const handleSaveAll = async () => {
    setIsSaving(true)
    setSaveSuccess(false)
    try {
      await Promise.all([
        saveConfig('gemini_api_key', geminiKey),
        saveConfig('telegram_bot_token', telegramToken),
        saveConfig('telegram_chat_id', chatId),
        saveConfig('brain_rules', brainRules),
        saveConfig('camera_name', cameraName),
        saveConfig('route_left', routeLeft),
        saveConfig('route_right', routeRight),
        saveConfig('model_source', 'hybrid'),
        saveConfig('enable_fallback', 'false')
      ])
      await mutate()
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
    } catch (err) {
      alert("Failed to sync credentials.")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="max-w-4xl space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div>
        <h1 className="text-4xl font-black tracking-tighter text-white uppercase">ENGINE <span className="text-blue-500">ROOM</span></h1>
        <p className="text-slate-500 text-sm font-medium mt-1">Configure neural bridge and notification protocols.</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Left Side: Rules & Spatial Location */}
        <div className="space-y-6">
          <section className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-8 space-y-4 ring-1 ring-white/5">
            <div className="flex items-center gap-3 mb-2">
              <BrainCircuit className="text-purple-500" size={24} />
              <h2 className="text-lg font-bold text-white">Cognitive Protocols</h2>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">Define few-shot instructions for the Gemini 1.5 Flash vision model. These rules override default suspicious patterns.</p>
            <textarea 
              className="w-full h-48 bg-slate-950 border border-slate-800 rounded-2xl p-5 text-sm focus:ring-2 focus:ring-purple-500/50 outline-none font-mono text-slate-300 transition-all"
              placeholder="Ex: Ignorar funcionários de uniforme vermelho..."
              value={brainRules}
              onChange={e => setBrainRules(e.target.value)}
            />
          </section>

          <section className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-8 space-y-6 ring-1 ring-white/5 animate-in fade-in duration-500">
            <div className="flex items-center gap-3 mb-2">
              <MapPin className="text-cyan-500" size={24} />
              <h2 className="text-lg font-bold text-white">Spatial Localization</h2>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">Map the camera location and directions of exit to context-aware corridors or alarms.</p>
            
            <div className="space-y-4">
              <div className="group">
                <label className="text-[10px] font-black text-slate-500 uppercase ml-1 mb-2 block tracking-widest">Camera Identification</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 text-sm text-white focus:border-cyan-500/50 outline-none transition-all font-medium"
                  placeholder="Ex: Corredor das Bebidas Premium"
                  value={cameraName}
                  onChange={e => setCameraName(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="group">
                  <label className="text-[10px] font-black text-slate-500 uppercase ml-1 mb-2 block tracking-widest">Left Exit Route (←)</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 text-sm text-white focus:border-cyan-500/50 outline-none transition-all font-medium"
                    placeholder="Ex: Setor de Massas"
                    value={routeLeft}
                    onChange={e => setRouteLeft(e.target.value)}
                  />
                </div>
                <div className="group">
                  <label className="text-[10px] font-black text-slate-500 uppercase ml-1 mb-2 block tracking-widest">Right Exit Route (→)</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 text-sm text-white focus:border-cyan-500/50 outline-none transition-all font-medium"
                    placeholder="Ex: Saída / Caixas"
                    value={routeRight}
                    onChange={e => setRouteRight(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Right Side: Secrets */}
        <div className="space-y-6">

          <section className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-8 space-y-6 ring-1 ring-white/5">
            <div className="flex items-center gap-3 mb-2">
              <Key className="text-blue-500" size={24} />
              <h2 className="text-lg font-bold text-white">Vault Credentials</h2>
            </div>

            <div className="space-y-4">
              <div className="group">
                <label className="text-[10px] font-black text-slate-500 uppercase ml-1 mb-2 block tracking-widest">Gemini API Key</label>
                <input 
                  type="password" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 text-sm text-white focus:border-blue-500/50 outline-none transition-all"
                  value={geminiKey}
                  onChange={e => setGeminiKey(e.target.value)}
                />
              </div>

              <div className="group">
                <label className="text-[10px] font-black text-slate-500 uppercase ml-1 mb-2 block tracking-widest">Telegram Token</label>
                <input 
                  type="password" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 text-sm text-white focus:border-blue-500/50 outline-none transition-all"
                  value={telegramToken}
                  onChange={e => setTelegramToken(e.target.value)}
                />
              </div>

              <div className="group">
                <label className="text-[10px] font-black text-slate-500 uppercase ml-1 mb-2 block tracking-widest">Chat ID</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-5 py-4 text-sm text-white focus:border-blue-500/50 outline-none transition-all"
                  value={chatId}
                  onChange={e => setChatId(e.target.value)}
                />
              </div>
            </div>

            <button 
              onClick={handleSaveAll}
              disabled={isSaving}
              className={`w-full py-5 rounded-2xl font-black text-xs uppercase tracking-[0.2em] flex items-center justify-center gap-3 transition-all shadow-xl ${
                saveSuccess 
                ? 'bg-emerald-600 text-white' 
                : 'bg-white text-slate-950 hover:bg-blue-500 hover:text-white'
              }`}
            >
              {isSaving ? <Loader2 className="animate-spin" size={20} /> : saveSuccess ? <CheckCircle2 size={20} /> : <Save size={20} />}
              {saveSuccess ? 'Protocols Synced' : 'Sync Core Logic'}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
