import React, { useState, useEffect, useRef } from 'react'
import DevicesTab from './components/DevicesTab'
import TelemetryTab from './components/TelemetryTab'
import VesselTab from './components/VesselTab'
import NetworkTab from './components/NetworkTab'
import SamplingCameraTab from './components/SamplingCameraTab'
import { Terminal, ShieldCheck, Cpu } from 'lucide-react'

export default function App() {
  const [activeTab, setActiveTab] = useState<'devices' | 'telemetry' | 'vessel' | 'network' | 'camera'>('vessel')
  const [logs, setLogs] = useState<string[]>([])
  const logContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Connect to IPC logging redirector
    const unsubscribe = window.electronAPI.onLog((msg) => {
      const timestamp = new Date().toLocaleTimeString()
      setLogs((prev) => [...prev, `[${timestamp}] ${msg}`].slice(-300)) // Keep last 300 logs
    })

    const initialTimestamp = new Date().toLocaleTimeString()
    setLogs([`[${initialTimestamp}] Electron Application launched successfully.`])

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    // Auto Scroll Logs to Bottom
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [logs])

  const clearLogs = () => setLogs([])

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 select-none">
      {/* --- TOP HEADER --- */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-gray-900 shadow-md">
        <div className="flex items-center gap-3">
          <Cpu className="text-orange-500 w-6 h-6 animate-pulse" />
          <h1 className="text-md font-extrabold tracking-wider bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">
            NWFSC VESSEL SIMULATOR
          </h1>
        </div>
      </header>

      {/* --- TABBED NAVIGATION --- */}
      <nav className="flex px-4 bg-gray-900/60 border-b border-gray-800/50 text-sm font-medium">
        <button
          onClick={() => setActiveTab('vessel')}
          className={`px-5 py-2.5 border-b-2 transition-all ${
            activeTab === 'vessel'
              ? 'border-orange-500 text-orange-400 bg-orange-500/5 font-semibold'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
          }`}
        >
          Vessel Simulator
        </button>
        <button
          onClick={() => setActiveTab('devices')}
          className={`px-5 py-2.5 border-b-2 transition-all ${
            activeTab === 'devices'
              ? 'border-orange-500 text-orange-400 bg-orange-500/5 font-semibold'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
          }`}
        >
          Backdeck Devices
        </button>
        <button
          onClick={() => setActiveTab('network')}
          className={`px-5 py-2.5 border-b-2 transition-all ${
            activeTab === 'network'
              ? 'border-orange-500 text-orange-400 bg-orange-500/5 font-semibold'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
          }`}
        >
          Network Diagnostics
        </button>
        <button
          onClick={() => setActiveTab('telemetry')}
          className={`px-5 py-2.5 border-b-2 transition-all ${
            activeTab === 'telemetry'
              ? 'border-orange-500 text-orange-400 bg-orange-500/5 font-semibold'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
          }`}
        >
          Telemetry Forwarding
        </button>
        <button
          onClick={() => setActiveTab('camera')}
          className={`px-5 py-2.5 border-b-2 transition-all ${
            activeTab === 'camera'
              ? 'border-orange-500 text-orange-400 bg-orange-500/5 font-semibold'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
          }`}
        >
          Sampling Camera
        </button>
      </nav>

      {/* --- ACTIVE TAB ELEMENT PANEL --- */}
      <main className="flex-grow overflow-hidden flex flex-col p-4">
        <div className="flex-grow bg-gray-900/40 border border-gray-800/60 rounded-lg shadow-2xl p-4 overflow-hidden">
          {activeTab === 'devices' && <DevicesTab />}
          {activeTab === 'telemetry' && <TelemetryTab />}
          {activeTab === 'vessel' && <VesselTab />}
          {activeTab === 'network' && <NetworkTab />}
          {activeTab === 'camera' && <SamplingCameraTab />}
        </div>
      </main>

      {/* --- BOTTOM TRANSMISSION LOGGER WINDOW --- */}
      <footer className="h-44 border-t border-gray-800 bg-gray-950 p-3 flex flex-col shrink-0 shadow-inner">
        <div className="flex justify-between items-center mb-1 bg-gray-900/40 border-b border-gray-800/30 pb-1">
          <span className="flex items-center gap-2 text-xs font-semibold tracking-wider text-orange-400">
            <Terminal className="w-3.5 h-3.5" />
            TRANSMISSION LOG
          </span>
          <button
            onClick={clearLogs}
            className="px-2 py-0.5 border border-gray-700/60 rounded text-[10px] text-gray-400 hover:text-gray-100 hover:bg-gray-800 hover:border-gray-500 transition font-medium"
          >
            Clear Log
          </button>
        </div>
        <div
          ref={logContainerRef}
          className="flex-grow overflow-y-auto font-mono text-[11px] leading-tight text-emerald-400/90 space-y-0.5 selection:bg-emerald-950 select-text"
        >
          {logs.map((log, index) => (
            <div key={index} className="hover:bg-emerald-950/20 px-1 py-0.5 rounded-sm">
              {log}
            </div>
          ))}
        </div>
      </footer>
    </div>
  )
}
