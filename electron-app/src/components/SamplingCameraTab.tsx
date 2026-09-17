import React, { useState, useEffect, useRef } from 'react'
import { Camera, CameraOff, Play, Square, Terminal, Shield, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'

export default function SamplingCameraTab() {
  const [active, setActive] = useState(false)
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState(8888)
  const [logs, setLogs] = useState<string[]>([])
  
  // Real-time camera states polled from backend
  const [camState, setCamState] = useState({
    species: 'COWCOD',
    angler_position: '1',
    drop_number: '3',
    hook_number: '2',
    site_number: '241',
    is_recording: true,
    video_quality: 'high',
    video_resolution: '1280x720',
    vflip: false,
    hflip: false,
    temperature: 34.5
  })
  
  const [imgCount, setImgCount] = useState(0)
  const [streamUrl, setStreamUrl] = useState('')
  const logConsoleRef = useRef<HTMLDivElement>(null)

  // Load initial status
  useEffect(() => {
    window.electronAPI.getCameraStatus().then((status) => {
      setActive(status.active)
      setHost(status.host)
      setPort(status.port)
      setLogs(status.logs)
      if (status.state) {
        setCamState(status.state)
      }
      if (status.active) {
        setStreamUrl(`http://${status.host}:${status.port}/cutter-cam/video?t=${Date.now()}`)
        pollImageCount(status.host, status.port)
      }
    })

    // Listen for log stream
    const unsubscribeLog = window.electronAPI.onCameraLog((logLine) => {
      setLogs((prev) => [...prev, logLine].slice(-200)) // limit to 200 lines
    })

    return () => {
      unsubscribeLog()
    }
  }, [])

  // Auto-scroll logs terminal
  useEffect(() => {
    if (logConsoleRef.current) {
      logConsoleRef.current.scrollTop = logConsoleRef.current.scrollHeight
    }
  }, [logs])

  // Periodic polling for status when active
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      window.electronAPI.getCameraStatus().then((status) => {
        if (status.state) {
          setCamState(status.state)
        }
      })
      pollImageCount(host, port)
    }, 3000)

    return () => clearInterval(timer)
  }, [active, host, port])

  const pollImageCount = async (h: string, p: number) => {
    try {
      const res = await fetch(`http://${h}:${p}/cutter-cam/image-count`)
      if (res.ok) {
        const data = await res.json()
        setImgCount(data.current_image_count)
      }
    } catch {
      // Server might be stopped
    }
  }

  const handleToggleServer = async () => {
    if (active) {
      const success = await window.electronAPI.stopCameraServer()
      if (success) {
        setActive(false)
        setStreamUrl('')
        setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Simulated Camera Server Stopped.`])
      }
    } else {
      const p = Number(port)
      if (isNaN(p) || p <= 0 || p > 65535) {
        alert('Please enter a valid port number.')
        return
      }
      const res = await window.electronAPI.startCameraServer(host.trim(), p)
      if (res.success) {
        setActive(true)
        setStreamUrl(`http://${host.trim()}:${p}/cutter-cam/video?t=${Date.now()}`)
        setTimeout(() => pollImageCount(host.trim(), p), 500)
      } else {
        alert(`Failed to start server: ${res.msg}`)
      }
    }
  }

  // --- Manual API Override Triggers ---
  const triggerManualCapture = async () => {
    if (!active) return
    try {
      const filename = `presim_HD_${new Date().toISOString().replace(/[-:]/g, '').substring(0, 15)}.jpeg`
      const res = await fetch(`http://${host}:${port}/cutter-cam/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: filename,
          exif: {
            species: camState.species,
            site: camState.site_number,
            drop: camState.drop_number,
            hook: camState.hook_number,
            captured_by: "Simulated Cutter Cam Tab"
          }
        })
      })
      if (res.ok) {
        pollImageCount(host, port)
      }
    } catch (err: any) {
      alert(`Manual Capture Error: ${err.message}`)
    }
  }

  const triggerClearImages = async () => {
    if (!active) return
    if (!confirm("Are you sure you want to clear all simulated captured photos?")) return
    try {
      const res = await fetch(`http://${host}:${port}/cutter-cam/clear-image-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret_key: 'D3l3t3ME!' })
      })
      if (res.ok) {
        pollImageCount(host, port)
      }
    } catch (err: any) {
      alert(`Clear Images Error: ${err.message}`)
    }
  }

  return (
    <div className="flex flex-col h-full gap-4 text-gray-200">
      {/* Tab Header Description */}
      <div className="shrink-0 flex items-center justify-between bg-gray-900/40 p-3 rounded-lg border border-gray-800/60 shadow-md">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Simulated Overhead Sampling Camera (Cutter Cam)</h3>
          <p className="text-[10px] text-gray-500">
            Simulates a Raspberry Pi POE Camera used overhead at the cutting station. Exposes identical FastAPI endpoints and MJPEG feeds on your local network.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {active ? (
            <span className="flex items-center gap-1 text-[10px] bg-emerald-950/60 border border-emerald-800 text-emerald-400 font-bold px-2 py-0.5 rounded shadow-inner">
              <Camera className="w-3 h-3 animate-pulse" />
              LIVE STREAM ACTIVE
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] bg-gray-950/60 border border-gray-800 text-gray-500 font-bold px-2 py-0.5 rounded shadow-inner">
              <CameraOff className="w-3 h-3" />
              OFFLINE
            </span>
          )}
        </div>
      </div>

      <div className="flex-grow grid grid-cols-12 gap-4 overflow-hidden">
        {/* LEFT COLUMN: Controls & Mock State Readout */}
        <div className="col-span-4 flex flex-col gap-3 overflow-y-auto">
          {/* Server Config & Toggle Card */}
          <div className="bg-gray-900/25 border border-gray-800 p-3.5 rounded-lg flex flex-col gap-3 shadow-md">
            <h4 className="text-xs font-bold text-gray-400 border-b border-gray-800 pb-1.5 flex items-center gap-1">
              <Shield className="w-3.5 h-3.5 text-orange-500" />
              SERVER INTERFACE CONFIG
            </h4>
            
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 flex flex-col gap-0.5 font-mono">
                <span className="text-[8px] font-bold text-gray-600">IP BIND ADDRESS</span>
                <input
                  type="text"
                  value={host}
                  disabled={active}
                  onChange={(e) => setHost(e.target.value)}
                  className="bg-gray-950/60 border border-gray-800/80 rounded px-2 py-1 text-xs text-orange-400 font-semibold focus:outline-none focus:border-orange-500 disabled:opacity-50"
                />
              </div>
              <div className="flex flex-col gap-0.5 font-mono">
                <span className="text-[8px] font-bold text-gray-600">PORT</span>
                <input
                  type="number"
                  value={port}
                  disabled={active}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="bg-gray-950/60 border border-gray-800/80 rounded px-2 py-1 text-xs text-orange-400 font-semibold focus:outline-none focus:border-orange-500 disabled:opacity-50"
                />
              </div>
            </div>

            <button
              onClick={handleToggleServer}
              className={`w-full py-1.5 rounded text-xs font-bold transition-all shadow-md cursor-pointer flex items-center justify-center gap-1.5 active:scale-95 ${
                active
                  ? 'bg-red-950 hover:bg-red-900 border border-red-700/80 text-red-300'
                  : 'bg-emerald-950 hover:bg-emerald-900 border border-emerald-700/80 text-emerald-300'
              }`}
            >
              {active ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  STOP CAMERA SERVER
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  START SIMULATED CAMERA
                </>
              )}
            </button>
          </div>

          {/* Simulated Active State Metrics Card */}
          <div className="bg-gray-900/25 border border-gray-800 p-3.5 rounded-lg flex flex-col gap-2.5 shadow-md">
            <h4 className="text-xs font-bold text-gray-400 border-b border-gray-800 pb-1.5 flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5 text-orange-500" />
              CAMERA DIAGNOSTICS READOUT
            </h4>

            <div className="flex flex-col gap-1 font-mono text-[10px] text-gray-300">
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>RPI Core Temp:</span>
                <span className="text-gray-100 font-bold">{active ? camState.temperature.toFixed(1) : '0.0'} °C</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Streaming Resol:</span>
                <span className="text-gray-100 font-bold">{camState.video_resolution}</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Sensor V-Flip:</span>
                <span className="text-gray-100 font-bold">{camState.vflip ? 'ACTIVE' : 'OFF'}</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Sensor H-Flip:</span>
                <span className="text-gray-100 font-bold">{camState.hflip ? 'ACTIVE' : 'OFF'}</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Active Species:</span>
                <span className="text-emerald-400 font-bold">{active ? camState.species : 'NONE'}</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Cutter Angler:</span>
                <span className="text-gray-100 font-bold">{active ? `Angler ${camState.angler_position}` : 'N/A'}</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Drop / Hook:</span>
                <span className="text-gray-100 font-bold">{active ? `Drop ${camState.drop_number} / Hook ${camState.hook_number}` : 'N/A'}</span>
              </div>
              <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
                <span>Site Number:</span>
                <span className="text-gray-100 font-bold">{active ? `Site ${camState.site_number}` : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span>Saved Image Count:</span>
                <span className="text-orange-400 font-bold">{imgCount} photos</span>
              </div>
            </div>
          </div>

          {/* Manual Overrides Debug Panel */}
          <div className="bg-gray-900/25 border border-gray-800 p-3.5 rounded-lg flex flex-col gap-2 shadow-md shrink-0">
            <h4 className="text-xs font-bold text-gray-400 border-b border-gray-800 pb-1.5 flex items-center gap-1">
              <FolderOpen className="w-3.5 h-3.5 text-orange-500" />
              API TEST MANUVAL OVERRIDES
            </h4>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                disabled={!active}
                onClick={triggerManualCapture}
                className="py-1 px-2 border border-gray-800 hover:border-gray-700 bg-gray-900/60 hover:bg-gray-800/60 text-[10px] font-bold rounded flex items-center justify-center gap-1 cursor-pointer transition disabled:opacity-50 disabled:pointer-events-none active:scale-95"
              >
                <Camera className="w-3 h-3 text-emerald-400" />
                MOCK PHOTO CAPTURE
              </button>
              <button
                disabled={!active}
                onClick={triggerClearImages}
                className="py-1 px-2 border border-gray-800 hover:border-red-950 bg-gray-900/60 hover:bg-red-950/20 text-[10px] font-bold rounded flex items-center justify-center gap-1 cursor-pointer transition text-gray-300 hover:text-red-400 disabled:opacity-50 disabled:pointer-events-none active:scale-95"
              >
                <Trash2 className="w-3 h-3" />
                CLEAR IMAGES
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Video Viewport & REST API Logs Terminal */}
        <div className="col-span-8 flex flex-col gap-4 overflow-hidden h-full">
          {/* Video Viewport Area */}
          <div className="flex-grow bg-gray-950 border border-gray-800 rounded-lg overflow-hidden flex items-center justify-center relative shadow-inner">
            {active ? (
              <img
                src={streamUrl}
                alt="Simulated live video feed"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 select-none">
                <CameraOff className="w-10 h-10 text-gray-700" />
                <span className="text-xs text-gray-500 font-bold uppercase tracking-wider">Cutter Cam Feed Inactive</span>
                <span className="text-[10px] text-gray-600">Start the Simulated Camera server to generate active MJPEG feed</span>
              </div>
            )}
          </div>

          {/* Log Monitor Console */}
          <div className="h-44 bg-gray-950 border border-gray-800 rounded-lg flex flex-col overflow-hidden shadow-inner shrink-0">
            <div className="bg-gray-900/45 px-3 py-1.5 border-b border-gray-800 flex items-center justify-between text-[10px] font-bold tracking-wider uppercase text-gray-500 shrink-0">
              <span className="flex items-center gap-1">
                <Terminal className="w-3.5 h-3.5 text-orange-500 animate-pulse" />
                REST API Incoming Transactions Terminal Monitor
              </span>
              <button
                onClick={() => setLogs([])}
                className="text-[9px] hover:text-orange-400 uppercase tracking-widest font-semibold cursor-pointer"
              >
                Clear Terminal
              </button>
            </div>
            
            <div
              ref={logConsoleRef}
              className="flex-grow p-3 font-mono text-[9px] leading-relaxed text-emerald-400 overflow-y-auto whitespace-pre-wrap select-text selection:bg-emerald-950"
            >
              {logs.map((line, idx) => (
                <div key={idx} className="hover:bg-emerald-950/10 rounded-sm px-1 py-0.5">
                  {line}
                </div>
              ))}
              {logs.length === 0 && (
                <span className="text-gray-600 italic">No REST API transactions logged yet. Start server to monitor packets...</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}