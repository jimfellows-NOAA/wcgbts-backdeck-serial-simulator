import React, { useState, useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'

const DEVICE_GROUPS: Record<string, string[]> = {
  "GPS": ["$GPGLL", "$GPHDT", "$GPRMC", "$GPVTG"],
  "ITI_Trawl_System": ["$IIDBS", "$IIGLL", "@IIHFB", "@IIMTW", "@IITDS", "@IITPT"],
  "Furuno_Attitude_Heave": ["$PFEC,GPatt", "$PFEC,GPhve"],
  "Echosounder_Depth_Temp": ["$SDDBS", "$SDDBT", "$SDDPT", "$SDMTW"],
  "$PSIMP,D1": ["$PSIMP,D1"],
  "$PSIMTV80": ["$PSIMTV80"],
  "$WIMWV": ["$WIMWV"]
}

interface BroadcastPort {
  id: string
  device: string
  protocol: 'SERIAL' | 'UDP' | 'TCP'
  hz: number
  comPort?: string
  baud?: number
  host?: string
  netPort?: number
  sentences: string[]
}

interface VesselState {
  mode: string
  lat: number
  lon: number
  speed: number
  depth: number
  sweptArea: number
  heading: number
  trackHistory: Array<[number, number, number]>
  breadcrumbEnabled: boolean
}

export default function VesselTab() {
  const [comPorts, setComPorts] = useState<string[]>([])
  
  // Vessel simulation states
  const [vessel, setVessel] = useState<VesselState>({
    mode: 'Idle',
    lat: 38.035,
    lon: -123.394,
    speed: 0.0,
    depth: 0.0,
    sweptArea: 0.00,
    heading: 0.0,
    trackHistory: [],
    breadcrumbEnabled: true
  })

  const [speedVal, setSpeedVal] = useState(10.0)
  const [mapZoom, setMapZoom] = useState(5000.0) // pixels per degree

  // Ports lists state
  const [broadcastPorts, setBroadcastPorts] = useState<BroadcastPort[]>([])

  // Form inputs state
  const [newDevice, setNewDevice] = useState('GPS')
  const [newProtocol, setNewProtocol] = useState('UDP')
  const [newHz, setNewHz] = useState('1 Hz')
  
  // Serial specific form states
  const [newPort, setNewPort] = useState('COM13')
  const [newBaud, setNewBaud] = useState('4800')

  // Network specific form states
  const [newHost, setNewHost] = useState('127.0.0.1')
  const [newNetPort, setNewNetPort] = useState('10110')

  // Selected sentences filter
  const [selectedSentences, setSelectedSentences] = useState<string[]>([])

  // Live simulated NMEA logs terminal state
  const [nmeaLogs, setNmeaLogs] = useState<string[]>([])
  
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nmeaLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electronAPI.getAvailablePorts().then((ports) => setComPorts(ports))
    
    // Load config
    window.electronAPI.loadConfig().then((config) => {
      if (config.vessel_speed) {
        setSpeedVal(config.vessel_speed)
        window.electronAPI.updateVesselSpeed(config.vessel_speed)
      }
      if (config.vessel_zoom) setMapZoom(config.vessel_zoom)
      if (config.vessel_ports) {
        // Sanitize legacy port records dynamically on mount
        const sanitized = config.vessel_ports.map((p: any) => {
          const deviceName = p.device || 'GPS'
          const defaultSentences = DEVICE_GROUPS[deviceName] || []
          const mappedProto = p.protocol || 'UDP'
          return {
            ...p,
            id: p.id || Math.random().toString(36).substring(2, 9),
            sentences: p.sentences || defaultSentences,
            protocol: mappedProto,
            comPort: p.comPort || (mappedProto === 'SERIAL' ? (p.port ? `COM${p.port - 6000}` : 'COM13') : undefined),
            netPort: p.netPort || (mappedProto !== 'SERIAL' ? (p.port || 10110) : undefined),
            host: p.host || '127.0.0.1'
          }
        })
        setBroadcastPorts(sanitized)
      }
    })

    // Listen to 1Hz state updates
    const unsubscribeState = window.electronAPI.onVesselState((newState) => {
      setVessel(newState)
    })

    // Listen to NMEA sentences stream from active runners and prepend protocol indicator
    const unsubscribeNmea = window.electronAPI.onVesselNmea((data: any) => {
      let text = ''
      if (typeof data === 'string') {
        text = data
      } else if (data && data.payload) {
        const protoLabel = data.protocol === 'SERIAL' ? 'SER' : data.protocol
        const prefix = `[${protoLabel}] `
        const lines = data.payload.split('\n').filter(Boolean).map((l: string) => `${prefix}${l}\n`)
        text = lines.join('')
      }

      if (!text) return

      setNmeaLogs((prev) => {
        const lines = text.split('\n').filter(Boolean).map((l) => l + '\n')
        return [...prev, ...lines].slice(-40) // limit console to 40 lines
      })
    })

    return () => {
      unsubscribeState()
      unsubscribeNmea()
    }
  }, [])

  // Set default selected sentences when the device changes
  useEffect(() => {
    const defaultSentences = DEVICE_GROUPS[newDevice] || []
    setSelectedSentences(defaultSentences)
  }, [newDevice])

  // Automatically default port when protocol changes
  useEffect(() => {
    if (newProtocol === 'UDP' || newProtocol === 'TCP') {
      setNewNetPort('10110')
    }
  }, [newProtocol])

  // Live Map Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    const cx = width / 2
    const cy = height / 2
    const cosLat = Math.cos((vessel.lat * Math.PI) / 180.0)

    const project = (lat: number, lon: number): [number, number] => {
      const dx = (lon - vessel.lon) * cosLat * mapZoom
      const dy = (vessel.lat - lat) * mapZoom
      return [cx + dx, cy + dy]
    }

    // 1. Draw grid lines (latitude / longitude)
    const lonSpan = (width / 2) / (mapZoom * cosLat)
    const latSpan = (height / 2) / mapZoom

    const minLon = vessel.lon - lonSpan
    const maxLon = vessel.lon + lonSpan
    const minLat = vessel.lat - latSpan
    const maxLat = vessel.lat + latSpan

    const gridStep = 0.05
    const startLon = Math.floor(minLon / gridStep) * gridStep
    const startLat = Math.floor(minLat / gridStep) * gridStep

    ctx.strokeStyle = '#1e293b' // slate-800
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])
    ctx.font = '9px monospace'
    ctx.fillStyle = '#64748b' // slate-500

    // Lon Grid
    for (let lon = startLon; lon <= maxLon; lon += gridStep) {
      const [x] = project(vessel.lat, lon)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.fillText(`${Math.abs(lon).toFixed(2)}°W`, x + 2, height - 8)
    }

    // Lat Grid
    for (let lat = startLat; lat <= maxLat; lat += gridStep) {
      const [, y] = project(lat, vessel.lon)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.fillText(`${lat.toFixed(2)}°N`, 4, y - 2)
    }

    // 2. Draw WCGBTS survey boundary box (dotted orange)
    const pts = [
      project(48.5, -125.5),
      project(48.5, -117.5),
      project(32.5, -117.5),
      project(32.5, -125.5)
    ]
    ctx.strokeStyle = '#f97316' // orange-500
    ctx.setLineDash([3, 5])
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    ctx.lineTo(pts[1][0], pts[1][1])
    ctx.lineTo(pts[2][0], pts[2][1])
    ctx.lineTo(pts[3][0], pts[3][1])
    ctx.closePath()
    ctx.stroke()
    ctx.fillStyle = '#f97316'
    ctx.fillText('WCGBTS Grid Box', pts[0][0] + 8, pts[0][1] + 12)

    // 3. Draw trail (breadcrumbs)
    if (vessel.breadcrumbEnabled && vessel.trackHistory.length > 1) {
      ctx.strokeStyle = '#38bdf8' // sky-400
      ctx.setLineDash([])
      ctx.lineWidth = 2
      ctx.beginPath()
      const [sx, sy] = project(vessel.trackHistory[0][0], vessel.trackHistory[0][1])
      ctx.moveTo(sx, sy)
      for (let i = 1; i < vessel.trackHistory.length; i++) {
        const [px, py] = project(vessel.trackHistory[i][0], vessel.trackHistory[i][1])
        ctx.lineTo(px, py)
      }
      ctx.stroke()
    }

    // 4. Draw Current Vessel (stylized triangle pointing to heading)
    ctx.setLineDash([])
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate((vessel.heading * Math.PI) / 180)
    ctx.fillStyle = '#ff4500' // orange-red
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, -12)
    ctx.lineTo(-6, 8)
    ctx.lineTo(0, 4)
    ctx.lineTo(6, 8)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()

  }, [vessel, mapZoom])

  useEffect(() => {
    if (nmeaLogRef.current) nmeaLogRef.current.scrollTop = nmeaLogRef.current.scrollHeight
  }, [nmeaLogs])

  const handleStart = () => window.electronAPI.startVesselSim()
  const handleStop = () => window.electronAPI.stopVesselSim()

  const handleSpeedSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    setSpeedVal(val)
    window.electronAPI.updateVesselSpeed(val)
    window.electronAPI.saveConfig('vessel_speed', val)
  }

  const handleZoomSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    setMapZoom(val)
    window.electronAPI.saveConfig('vessel_zoom', val)
  }

  const handleBreadcrumbsToggle = () => {
    const next = !vessel.breadcrumbEnabled
    window.electronAPI.toggleVesselBreadcrumbs(next)
  }

  const addPort = async () => {
    const hzVal = parseInt(newHz.split(' ')[0])

    if (newProtocol === 'SERIAL') {
      if (!newPort) return alert('Please select a COM port.')
    } else {
      if (!newHost.trim()) return alert('Please specify a publish host/IP.')
      const netPortNum = parseInt(newNetPort)
      if (isNaN(netPortNum) || netPortNum < 1 || netPortNum > 65535) {
        return alert('Please specify a valid network port (1-65535).')
      }
    }

    if (selectedSentences.length === 0) {
      return alert('Please select at least one NMEA sentence type.')
    }

    const newBPort: BroadcastPort = {
      id: Math.random().toString(36).substring(2, 9),
      device: newDevice,
      protocol: newProtocol as 'SERIAL' | 'UDP' | 'TCP',
      hz: hzVal,
      comPort: newProtocol === 'SERIAL' ? newPort : undefined,
      baud: newProtocol === 'SERIAL' ? parseInt(newBaud) : undefined,
      host: newProtocol !== 'SERIAL' ? newHost.trim() : undefined,
      netPort: newProtocol !== 'SERIAL' ? parseInt(newNetPort) : undefined,
      sentences: selectedSentences
    }

    const res = await window.electronAPI.addVesselPort(newBPort)
    if (res.success) {
      const updated = [...broadcastPorts, newBPort]
      setBroadcastPorts(updated)
      window.electronAPI.saveConfig('vessel_ports', updated)
    } else {
      alert(res.msg)
    }
  }

  const removePort = async (id: string) => {
    await window.electronAPI.removeVesselPort(id)
    const updated = broadcastPorts.filter((p) => p.id !== id)
    setBroadcastPorts(updated)
    window.electronAPI.saveConfig('vessel_ports', updated)
  }

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      {/* --- TOP CONTROL HEADER --- */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-lg shadow-sm shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-semibold">Source Mode:</span>
          <select value="Simulation" disabled className="bg-gray-800 border border-gray-700/60 rounded px-2.5 py-1 text-xs text-gray-300 font-semibold cursor-pointer">
            <option value="Simulation">Simulation</option>
          </select>
        </div>

        <button
          onClick={handleStart}
          disabled={vessel.mode !== 'Idle'}
          className="px-4 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded text-xs font-bold transition shadow cursor-pointer"
        >
          Start Simulator
        </button>

        <button
          onClick={handleStop}
          disabled={vessel.mode === 'Idle'}
          className="px-4 py-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded text-xs font-bold transition shadow cursor-pointer"
        >
          Stop Simulator
        </button>

        {/* Speed Adjustment */}
        <div className="flex items-center gap-2 flex-grow max-w-xs">
          <span className="text-xs text-gray-400 font-semibold shrink-0">Speed:</span>
          <input
            type="range"
            min="0"
            max="25"
            step="0.1"
            value={speedVal}
            onChange={handleSpeedSliderChange}
            className="flex-grow accent-orange-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
          />
          <span className="text-xs font-mono font-bold text-orange-400 w-12 text-right">{speedVal.toFixed(1)} kts</span>
        </div>

        {/* Map Zoom Slider */}
        <div className="flex items-center gap-2 flex-grow max-w-xs">
          <span className="text-xs text-gray-400 font-semibold shrink-0">Zoom:</span>
          <input
            type="range"
            min="1000"
            max="30000"
            step="500"
            value={mapZoom}
            onChange={handleZoomSliderChange}
            className="flex-grow accent-orange-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
          />
          <span className="text-xs font-mono font-bold text-orange-400 w-16 text-right">x{(mapZoom / 1000).toFixed(1)}</span>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="trail-chk"
            checked={vessel.breadcrumbEnabled}
            onChange={handleBreadcrumbsToggle}
            className="rounded border-gray-700 text-orange-500 focus:ring-orange-500 bg-gray-800 cursor-pointer w-3.5 h-3.5"
          />
          <label htmlFor="trail-chk" className="text-xs text-gray-400 font-semibold cursor-pointer">Trail</label>
        </div>
      </div>

      {/* --- THREE COLUMN LAYOUT --- */}
      <div className="flex-grow grid grid-cols-11 gap-3 overflow-hidden">
        {/* COLUMN 1: Readout Panel */}
        <div className="col-span-3 flex flex-col border border-gray-800/60 bg-gray-900/10 rounded-lg p-3 shrink-0">
          <h4 className="text-xs font-bold text-gray-400 tracking-wider mb-2">VESSEL TELEMETRY</h4>
          <div className="text-xs font-bold text-orange-400 bg-gray-900/40 px-2 py-1 rounded border border-gray-800 mb-3 shrink-0">
            Status: {vessel.mode}
          </div>

          <div className="flex-grow flex flex-col justify-center font-mono text-xs text-gray-300 gap-2 px-2">
            <div className="flex justify-between border-b border-gray-800/40 pb-1">
              <span>Latitude:</span>
              <span className="text-gray-100 font-bold">{vessel.lat.toFixed(6)}° N</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-1">
              <span>Longitude:</span>
              <span className="text-gray-100 font-bold">{vessel.lon.toFixed(6)}° W</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-1">
              <span>Vess Speed:</span>
              <span className="text-gray-100 font-bold">{vessel.speed.toFixed(2)} knots</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-1">
              <span>Floor Depth:</span>
              <span className="text-gray-100 font-bold">{vessel.depth} meters</span>
            </div>
            <div className="flex justify-between">
              <span>Area Swept:</span>
              <span className="text-emerald-400 font-bold">{vessel.sweptArea.toFixed(2)} ha</span>
            </div>
          </div>
        </div>

        {/* COLUMN 2: Native GIS Map Canvas */}
        <div className="col-span-4 border border-gray-800/60 bg-gray-950 rounded-lg overflow-hidden flex flex-col relative">
          <h4 className="text-[10px] font-bold text-gray-500 tracking-wider absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-gray-950/80 rounded border border-gray-800">
            NATIVE GIS CANVAS TRACKER
          </h4>
          <canvas
            ref={canvasRef}
            width={320}
            height={320}
            className="flex-grow w-full h-full block"
          ></canvas>
        </div>

        {/* COLUMN 3: Ports Config & Live Sentences Stream Monitor */}
        <div className="col-span-4 flex flex-col border border-gray-800/60 bg-gray-900/10 rounded-lg p-3 overflow-hidden">
          <h4 className="text-xs font-bold text-gray-400 tracking-wider mb-2 shrink-0">PORTS & NMEA STREAM</h4>

          {/* Ports Config Form */}
          <div className="flex flex-col gap-2 mb-3 bg-gray-900/50 p-3 rounded-lg border border-gray-800 shrink-0">
            {/* Top Row: Device, Protocol, Hz */}
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-bold text-gray-500 uppercase">Device</span>
                <select
                  value={newDevice}
                  onChange={(e) => setNewDevice(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none cursor-pointer w-full"
                >
                  {Object.keys(DEVICE_GROUPS).map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-bold text-gray-500 uppercase">Protocol</span>
                <select
                  value={newProtocol}
                  onChange={(e) => setNewProtocol(e.target.value as any)}
                  className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none cursor-pointer w-full"
                >
                  <option value="SERIAL">SERIAL</option>
                  <option value="UDP">UDP</option>
                  <option value="TCP">TCP</option>
                </select>
              </div>

              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-bold text-gray-500 uppercase">Hz Rate</span>
                <select
                  value={newHz}
                  onChange={(e) => setNewHz(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none cursor-pointer w-full"
                >
                  <option value="1 Hz">1 Hz</option>
                  <option value="2 Hz">2 Hz</option>
                  <option value="5 Hz">5 Hz</option>
                  <option value="10 Hz">10 Hz</option>
                </select>
              </div>
            </div>

            {/* Conditional Protocol Inputs Row */}
            {newProtocol === 'SERIAL' ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-gray-500 uppercase">COM Port</span>
                  <select
                    value={newPort}
                    onChange={(e) => setNewPort(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none cursor-pointer w-full font-mono"
                  >
                    {comPorts.length > 0 ? (
                      comPorts.map((p) => <option key={p} value={p}>{p}</option>)
                    ) : (
                      [...Array(18)].map((_, i) => {
                        const name = `COM${i + 3}`
                        return <option key={name} value={name}>{name}</option>
                      })
                    )}
                  </select>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Baud Rate</span>
                  <select
                    value={newBaud}
                    onChange={(e) => setNewBaud(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none cursor-pointer w-full font-mono"
                  >
                    <option value="4800">4800</option>
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                    <option value="38400">38400</option>
                    <option value="115200">115200</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Publish IP / Host</span>
                  <input
                    type="text"
                    value={newHost}
                    onChange={(e) => setNewHost(e.target.value)}
                    placeholder="127.0.0.1"
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-orange-500 w-full font-mono"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold text-gray-500 uppercase">Net Port</span>
                  <input
                    type="number"
                    value={newNetPort}
                    onChange={(e) => setNewNetPort(e.target.value)}
                    placeholder="10110"
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-orange-500 w-full font-mono"
                  />
                </div>
              </div>
            )}

            {/* Sentence Selector Box */}
            <div className="flex flex-col gap-1 bg-gray-950/40 p-2 rounded border border-gray-800 max-h-[75px] overflow-y-auto shrink-0">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Sentences ({selectedSentences.length} selected)</span>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-1">
                {(DEVICE_GROUPS[newDevice] || []).map((s) => (
                  <label key={s} className="flex items-center gap-1.5 text-[10px] text-gray-300 font-semibold cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={selectedSentences.includes(s)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedSentences([...selectedSentences, s])
                        } else {
                          setSelectedSentences(selectedSentences.filter((x) => x !== s))
                        }
                      }}
                      className="rounded border-gray-700 text-orange-500 focus:ring-orange-500 bg-gray-800 cursor-pointer w-3.5 h-3.5"
                    />
                    {s}
                  </label>
                ))}
              </div>
            </div>

            {/* Add Channel Button */}
            <button
              onClick={addPort}
              className="w-full py-1 bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white font-bold rounded text-xs transition shadow-sm cursor-pointer uppercase tracking-wider shrink-0"
            >
              Add Broadcast Channel
            </button>
          </div>

          {/* Active Ports List */}
          <div className="flex flex-col gap-1 overflow-y-auto max-h-28 p-1 border-b border-gray-800/40 pb-2 mb-2 shrink-0">
            {broadcastPorts.length === 0 ? (
              <span className="text-[10px] text-gray-500 italic text-center py-1">No active broadcast channels.</span>
            ) : (
              broadcastPorts.map((p) => {
                const label = p.protocol === 'SERIAL'
                  ? `${p.comPort} @ ${p.baud}`
                  : `${p.host}:${p.netPort}`
                return (
                  <div key={p.id} className="flex justify-between items-center px-2 py-1 bg-gray-950/40 rounded border border-gray-800">
                    <div className="flex flex-col">
                      <span className="font-mono text-[9px] font-bold text-gray-300">
                        {`${p.device} (${p.protocol}) -> ${label}`}
                      </span>
                      <span className="text-[8px] text-gray-500">
                        {p.hz} Hz • {(p.sentences || []).join(', ')}
                      </span>
                    </div>
                    <button
                      onClick={() => removePort(p.id)}
                      className="px-1.5 py-0.5 border border-rose-800 bg-rose-950/25 hover:bg-rose-900 rounded text-[9px] text-rose-400 font-bold transition cursor-pointer shrink-0 ml-2"
                    >
                      Remove
                    </button>
                  </div>
                )
              })
            )}
          </div>

          {/* Live Simulated NMEA Console */}
          <div className="flex-grow border border-gray-800 bg-gray-950/60 rounded-lg p-2.5 flex flex-col overflow-hidden min-h-[120px]">
            <div className="flex justify-between items-center mb-1 border-b border-gray-800/30 pb-1 shrink-0">
              <span className="text-[9px] font-bold text-gray-400 tracking-wider">
                LIVE SIMULATED NMEA STREAM
              </span>
              <button
                onClick={() => setNmeaLogs([])}
                className="text-[9px] text-gray-500 hover:text-gray-200"
              >
                Clear
              </button>
            </div>
            <div
              ref={nmeaLogRef}
              className="flex-grow overflow-y-auto font-mono text-[9px] text-emerald-400/95 leading-tight whitespace-pre select-text selection:bg-emerald-950"
            >
              {nmeaLogs.join('') || <span className="text-gray-600 italic">Start simulator to stream NMEA...</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
