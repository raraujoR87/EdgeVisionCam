"use client"
import useSWR from 'swr'
import { Activity, ShieldAlert, CheckCircle } from 'lucide-react'

const fetcher = (url: string) => fetch(url).then(res => res.json())

export default function Overview() {
  const { data: events, error: eventsError } = useSWR('http://localhost:8000/api/events', fetcher, { refreshInterval: 3000 })
  const { data: telemetry, error: telError } = useSWR('http://localhost:8000/api/telemetry', fetcher, { refreshInterval: 3000 })

  if (eventsError || telError) return <div className="text-red-500">Failed to load data</div>
  if (!events || !telemetry) return <div className="text-slate-500">Loading metrics...</div>

  const total = events.length
  const cleared = events.filter((e: any) => e.status === 'CLEARED').length
  const confirmed = events.filter((e: any) => e.status === 'THEFT_CONFIRMED').length

  const latestTel = telemetry[0] || { cpu_usage: 0, ram_usage: 0 }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div className="flex justify-between items-center mb-4">
            <Activity className="text-blue-500" />
            <span className="text-xs font-bold text-slate-500 uppercase">Total Analyzed</span>
          </div>
          <div className="text-4xl font-bold">{total}</div>
        </div>
        
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div className="flex justify-between items-center mb-4">
            <CheckCircle className="text-emerald-500" />
            <span className="text-xs font-bold text-slate-500 uppercase">Cleared</span>
          </div>
          <div className="text-4xl font-bold text-emerald-500">{cleared}</div>
        </div>
        
        <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div className="flex justify-between items-center mb-4">
            <ShieldAlert className="text-rose-500" />
            <span className="text-xs font-bold text-slate-500 uppercase">Critical Alerts</span>
          </div>
          <div className="text-4xl font-bold text-rose-500">{confirmed}</div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl">
        <h2 className="text-lg font-bold mb-4">Node Telemetry</h2>
        <div className="grid grid-cols-2 gap-4">
           <div className="p-4 bg-slate-950 rounded-xl">
             <div className="text-xs text-slate-500 mb-1 uppercase font-bold">CPU Usage</div>
             <div className="text-2xl font-mono text-blue-400">{latestTel.cpu_usage.toFixed(1)}%</div>
           </div>
           <div className="p-4 bg-slate-950 rounded-xl">
             <div className="text-xs text-slate-500 mb-1 uppercase font-bold">RAM Usage</div>
             <div className="text-2xl font-mono text-purple-400">{latestTel.ram_usage.toFixed(1)}%</div>
           </div>
        </div>
      </div>
    </div>
  )
}
