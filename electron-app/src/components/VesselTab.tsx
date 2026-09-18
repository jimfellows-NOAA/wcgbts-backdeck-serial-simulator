import React, { useState, useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'

const DEVICE_GROUPS: Record<string, string[]> = {
  "GPS": ["$GPGLL", "$GPHDT", "$GPRMC", "$GPVTG"],
  "ITI_Trawl_System": ["$IIDBS", "$IIGLL", "@IIHFB", "@IIMTW", "@IITDS", "@IITPT"],
  "Furuno_Attitude_Heave": ["$PFEC,GPatt", "$PFEC,GPhve"],
  "Echosounder_Depth_Temp": ["$SDDBS", "$SDDBT", "$SDDPT", "$SDMTW", "$YCMTW"],
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
  paused?: boolean
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
  // New variables
  waterTemp?: number
  windSpeedSet?: number
  windDirSet?: number
  depthSet?: number
  tempSet?: number
  windSpeedActive?: number
  windDirActive?: number
  windSpeedRelative?: number
  windDirRelative?: number
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
  const [windSpeedVal, setWindSpeedVal] = useState(5.0)
  const [windDirVal, setWindDirVal] = useState(240.0)
  const [depthVal, setDepthVal] = useState(300.0)
  const [tempVal, setTempVal] = useState(12.0)
  const [mapZoom, setMapZoom] = useState(5000.0) // pixels per degree

  const dialRef = useRef<SVGSVGElement>(null)
  const [isDraggingHeading, setIsDraggingHeading] = useState(false)

  const handleHeadingPointerDown = (e: React.MouseEvent<SVGSVGElement> | React.TouchEvent<SVGSVGElement>) => {
    setIsDraggingHeading(true)
    updateHeadingFromEvent(e)
  }

  const updateHeadingFromEvent = (e: any) => {
    const dial = dialRef.current
    if (!dial) return
    const rect = dial.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    
    let clientX = 0
    let clientY = 0
    if (e.touches && e.touches[0]) {
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }

    const dx = clientX - centerX
    const dy = clientY - centerY
    const angleRad = Math.atan2(dx, -dy)
    let headingDeg = (angleRad * 180 / Math.PI + 360) % 360
    headingDeg = Math.round(headingDeg)
    
    setVessel(prev => ({ ...prev, heading: headingDeg }))
    window.electronAPI.updateVesselHeading(headingDeg)
  }

  useEffect(() => {
    if (!isDraggingHeading) return

    const handlePointerMove = (e: PointerEvent) => {
      updateHeadingFromEvent(e)
    }

    const handlePointerUp = () => {
      setIsDraggingHeading(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [isDraggingHeading])

  const togglePortPause = async (id: string, currentPaused: boolean) => {
    const nextPaused = !currentPaused
    const res = await window.electronAPI.toggleVesselPortPause(id, nextPaused)
    if (res.success) {
      const updated = broadcastPorts.map((p) => p.id === id ? { ...p, paused: nextPaused } : p)
      setBroadcastPorts(updated)
      window.electronAPI.saveConfig('vessel_ports', updated)
    }
  }

  const setAllPortsPaused = async (paused: boolean) => {
    const res = await window.electronAPI.setAllVesselPortsPaused(paused)
    if (res.success) {
      const updated = broadcastPorts.map((p) => ({ ...p, paused }))
      setBroadcastPorts(updated)
      window.electronAPI.saveConfig('vessel_ports', updated)
    }
  }

  const [averages, setAverages] = useState({
    hdg: 0.0,
    sog: 0.0,
    tws: 5.0,
    twd: 240.0,
    rws: 5.0,
    rwd: 240.0,
    dep: 300.0,
    tmp: 12.0
  })

  const averageHistoryRef = useRef<Array<{
    hdg: number;
    sog: number;
    tws: number;
    twd: number;
    rws: number;
    rwd: number;
    dep: number;
    tmp: number;
    timestamp: number;
  }>>([])

  // Collect 1Hz samples for 5-minute rolling averages
  useEffect(() => {
    if (vessel.mode === 'Idle') {
      averageHistoryRef.current = []
      return
    }
    const interval = setInterval(() => {
      const now = Date.now()
      const sample = {
        hdg: vessel.heading ?? 0.0,
        sog: vessel.speed ?? 0.0,
        tws: vessel.windSpeedActive ?? 5.0,
        twd: vessel.windDirActive ?? 240.0,
        rws: vessel.windSpeedRelative ?? 5.0,
        rwd: vessel.windDirRelative ?? 240.0,
        dep: vessel.depth ?? 300.0,
        tmp: vessel.waterTemp ?? 12.0,
        timestamp: now
      }
      averageHistoryRef.current.push(sample)
      
      // Clean up samples older than 5 minutes (300,000 ms)
      const cutoff = now - 5 * 60 * 1000
      averageHistoryRef.current = averageHistoryRef.current.filter(s => s.timestamp >= cutoff)
      
      const history = averageHistoryRef.current
      if (history.length > 0) {
        // Calculate averages
        const arithmeticAvg = (key: 'sog' | 'tws' | 'rws' | 'dep' | 'tmp') => {
          return history.reduce((sum, s) => sum + s[key], 0) / history.length
        }
        
        const circularAvg = (key: 'hdg' | 'twd' | 'rwd') => {
          let sinSum = 0
          let cosSum = 0
          for (const s of history) {
            const rad = (s[key] * Math.PI) / 180
            sinSum += Math.sin(rad)
            cosSum += Math.cos(rad)
          }
          return (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360
        }
        
        setAverages({
          hdg: circularAvg('hdg'),
          sog: arithmeticAvg('sog'),
          tws: arithmeticAvg('tws'),
          twd: circularAvg('twd'),
          rws: arithmeticAvg('rws'),
          rwd: circularAvg('rwd'),
          dep: arithmeticAvg('dep'),
          tmp: arithmeticAvg('tmp')
        })
      }
    }, 1000)
    
    return () => clearInterval(interval)
  }, [
    vessel.mode,
    vessel.heading,
    vessel.speed,
    vessel.windSpeedActive,
    vessel.windDirActive,
    vessel.windSpeedRelative,
    vessel.windDirRelative,
    vessel.depth,
    vessel.waterTemp
  ])

  // Bind native non-passive wheel zoom listener to prevent React passive warnings
  const mapZoomRef = useRef(mapZoom)
  useEffect(() => {
    mapZoomRef.current = mapZoom
  }, [mapZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = -e.deltaY
      const zoomFactor = delta > 0 ? 1.15 : 0.85
      handleZoomChange(mapZoomRef.current * zoomFactor)
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [])

  // Trigger map canvas redraw on window resize to prevent stretching/distortion
  useEffect(() => {
    const handleResize = () => {
      setRedrawTrigger((prev) => prev + 1)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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

  // Manual coordinate input states
  const [manualLat, setManualLat] = useState('38.035')
  const [manualLon, setManualLon] = useState('-123.394')
  const [geoLoading, setGeoLoading] = useState(false)

  // Map Tile loader states
  const [redrawTrigger, setRedrawTrigger] = useState(0)
  const tileCacheRef = useRef<Record<string, HTMLImageElement>>({})
  
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nmeaLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electronAPI.getAvailablePorts().then((ports) => setComPorts(ports))
    
    // Load config
    window.electronAPI.loadConfig().then((config) => {
      if (config.vessel_speed) {
        const val = parseFloat(config.vessel_speed)
        const safeVal = isNaN(val) ? 10.0 : val
        setSpeedVal(safeVal)
        window.electronAPI.updateVesselSpeed(safeVal)
      }
      if (config.vessel_wind_speed_set) {
        const val = parseFloat(config.vessel_wind_speed_set)
        const safeVal = isNaN(val) ? 5.0 : val
        setWindSpeedVal(safeVal)
        window.electronAPI.updateWindSpeed(safeVal)
      }
      if (config.vessel_wind_dir_set) {
        const val = parseFloat(config.vessel_wind_dir_set)
        const safeVal = isNaN(val) ? 240.0 : val
        setWindDirVal(safeVal)
        window.electronAPI.updateWindDir(safeVal)
      }
      if (config.vessel_depth_set) {
        const val = parseFloat(config.vessel_depth_set)
        const safeVal = isNaN(val) ? 300.0 : val
        setDepthVal(safeVal)
        window.electronAPI.updateDepthSet(safeVal)
      }
      if (config.vessel_temp_set) {
        const val = parseFloat(config.vessel_temp_set)
        const safeVal = isNaN(val) ? 12.0 : val
        setTempVal(safeVal)
        window.electronAPI.updateTempSet(safeVal)
      }
      if (config.vessel_zoom) {
        const val = parseFloat(config.vessel_zoom)
        setMapZoom(isNaN(val) ? 5000.0 : val)
      }
      if (config.vessel_ports) {
        // Sanitize legacy port records dynamically on mount
        const sanitized = config.vessel_ports.map((p: any) => {
          const deviceName = p.device || 'GPS'
          const defaultSentences = DEVICE_GROUPS[deviceName] || []
          const mappedProto = p.protocol || 'UDP'

          const rawPort = p.comPort || (mappedProto === 'SERIAL' ? (p.port ? `COM${p.port - 6000}` : 'COM13') : undefined)
          const netPort = p.netPort || (mappedProto !== 'SERIAL' ? (p.port || 10110) : undefined)
          const endpoint = mappedProto === 'SERIAL' ? rawPort : netPort
          const deterministicId = `${mappedProto}_${endpoint}_${deviceName}`.replace(/[^a-zA-Z0-9_]/g, '_')

          return {
            ...p,
            id: p.id || deterministicId,
            sentences: p.sentences || defaultSentences,
            protocol: mappedProto,
            comPort: p.comPort || (mappedProto === 'SERIAL' ? (p.port ? `COM${p.port - 6000}` : 'COM13') : undefined),
            netPort: p.netPort || (mappedProto !== 'SERIAL' ? (p.port || 10110) : undefined),
            host: p.host || '127.0.0.1',
            paused: p.paused !== undefined ? p.paused : false
          }
        })
        setBroadcastPorts(sanitized)
      }
    })

    // Listen to 1Hz state updates
    const unsubscribeState = window.electronAPI.onVesselState((newState) => {
      setVessel((prev) => ({ ...prev, ...newState }))
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

  const loadTileImage = (z: number, x: number, y: number) => {
    const tileKey = `${z}_${x}_${y}`
    if (tileCacheRef.current[tileKey] !== undefined) return // already loaded or loading

    // mark as loading
    tileCacheRef.current[tileKey] = null as any

    window.electronAPI.getTile(z, x, y).then((base64Data) => {
      if (base64Data) {
        const img = new Image()
        img.onload = () => {
          tileCacheRef.current[tileKey] = img
          setRedrawTrigger((prev) => prev + 1)
        }
        img.src = `data:image/jpeg;base64,${base64Data}`
      }
    }).catch(() => {
      // ignore
    })
  }

  // Live Map Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Get client layout dimensions
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    
    // Scale logical canvas size to layout size * dpr (prevents ANY blurriness or distortion!)
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Scale context drawing by devicePixelRatio
    ctx.scale(dpr, dpr)

    const width = rect.width
    const height = rect.height
    
    // Default background color mimicking ocean bathymetry before tiles load
    ctx.fillStyle = '#0c1524'
    ctx.fillRect(0, 0, width, height)

    const cx = width / 2
    const cy = height / 2
    const cosLat = Math.cos((vessel.lat * Math.PI) / 180.0)

    const project = (lat: number, lon: number): [number, number] => {
      const dx = (lon - vessel.lon) * cosLat * mapZoom
      const dy = (vessel.lat - lat) * mapZoom
      return [cx + dx, cy + dy]
    }

    // 1. Draw ESRI Ocean Bathymetry tiles if available
    let z = 8
    if (mapZoom < 2000) z = 7
    else if (mapZoom < 4000) z = 8
    else if (mapZoom < 8000) z = 9
    else if (mapZoom < 15000) z = 10
    else if (mapZoom < 25000) z = 11
    else z = 12

    const n = Math.pow(2, z)
    const lonSpan = (width / 2) / (mapZoom * cosLat)
    const latSpan = (height / 2) / mapZoom

    const minLon = vessel.lon - lonSpan
    const maxLon = vessel.lon + lonSpan
    const minLat = vessel.lat - latSpan
    const maxLat = vessel.lat + latSpan

    const tileXMin = Math.floor(((minLon + 180) / 360) * n)
    const tileXMax = Math.floor(((maxLon + 180) / 360) * n)

    const toTileY = (lat: number) => {
      const latClamped = Math.max(-85, Math.min(85, lat))
      const latRad = (latClamped * Math.PI) / 180
      return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
    }
    const tileYMin = toTileY(maxLat)
    const tileYMax = toTileY(minLat)

    for (let tx = tileXMin; tx <= tileXMax; tx++) {
      for (let ty = tileYMin; ty <= tileYMax; ty++) {
        const tileKey = `${z}_${tx}_${ty}`
        const cached = tileCacheRef.current[tileKey]
        if (cached) {
          const tileLonMin = tx / n * 360 - 180
          const tileLatMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI
          const tileLonMax = (tx + 1) / n * 360 - 180
          const tileLatMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / n))) * 180 / Math.PI

          const [x1, y1] = project(tileLatMax, tileLonMin)
          const [x2, y2] = project(tileLatMin, tileLonMax)

          ctx.drawImage(cached, x1, y1, x2 - x1, y2 - y1)
        } else {
          loadTileImage(z, tx, ty)
        }
      }
    }

    // 2. Draw grid lines (latitude / longitude) on top of the tiles
    const gridStep = 0.05
    const startLon = Math.floor(minLon / gridStep) * gridStep
    const startLat = Math.floor(minLat / gridStep) * gridStep

    ctx.strokeStyle = 'rgba(30, 41, 59, 0.4)' // semi-transparent slate-800
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

    // 3. Draw WCGBTS survey boundary box (dotted orange)
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

    // 4. Draw trail (breadcrumbs)
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

    // 5. Draw Current Vessel (stylized triangle pointing to heading)
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

    // 6. Draw Nautical Instruments Panel in Top-Right Corner (Streamlined circular compass face)
    if (width > 120 && height > 120) {
      const dx = width - 60
      const dy = 68
      const r = 34

      // Draw semi-transparent background box for the compass with rounded corners and slight opacity (70%)
      ctx.fillStyle = "rgba(6, 16, 30, 0.70)"
      ctx.strokeStyle = "#1c2d3d"
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.roundRect(width - 110, 10, 100, 100, 8)
      ctx.fill()
      ctx.stroke()

      // Header title text
      ctx.fillStyle = "#5a7a8a"
      ctx.font = "bold 6.5px Arial"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("WIND & VESSEL BEARING", width - 60, 21)

      // Compass Circle
      ctx.strokeStyle = "#324a5e"
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(dx, dy, r, 0, 2 * Math.PI)
      ctx.stroke()

      // Cardinal directions (scaled for r = 34)
      ctx.fillStyle = "#ffffff"
      ctx.font = "bold 7px Arial"
      ctx.textBaseline = "middle"
      ctx.textAlign = "center"
      ctx.fillText("N", dx, dy - r + 7)
      ctx.fillText("S", dx, dy + r - 7)
      ctx.fillText("E", dx + r - 7, dy)
      ctx.fillText("W", dx - r + 7, dy)

      // Draw Vessel Icon in the center (representing its heading)
      ctx.save()
      ctx.translate(dx, dy)
      ctx.rotate((vessel.heading * Math.PI) / 180)
      ctx.fillStyle = '#ff4500' // orange-red
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, -7)
      ctx.lineTo(-3, 4)
      ctx.lineTo(0, 1)
      ctx.lineTo(3, 4)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()

      // Get wind directions
      const twDir = vessel.windDirActive ?? 240.0
      const rwDir = vessel.windDirRelative ?? 240.0

      // Draw True Wind Indicator (Green Arrow pointing towards center)
      const radTw = twDir * Math.PI / 180
      const twXStart = dx + (r - 2) * Math.sin(radTw)
      const twYStart = dy - (r - 2) * Math.cos(radTw)
      const twXEnd = dx + (r - 11) * Math.sin(radTw)
      const twYEnd = dy - (r - 11) * Math.cos(radTw)

      ctx.strokeStyle = "#00ff66"
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(twXStart, twYStart)
      ctx.lineTo(twXEnd, twYEnd)
      ctx.stroke()

      // Draw Arrow Head for True Wind
      ctx.save()
      ctx.translate(twXEnd, twYEnd)
      ctx.rotate(radTw)
      ctx.fillStyle = "#00ff66"
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-2.5, 5)
      ctx.lineTo(2.5, 5)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      // Label 'T' next to start
      const twLblX = dx + (r + 6) * Math.sin(radTw)
      const twLblY = dy - (r + 6) * Math.cos(radTw)
      ctx.fillStyle = "#00ff66"
      ctx.font = "bold 7px Arial"
      ctx.fillText("T", twLblX, twLblY)

      // Draw Relative Wind Indicator (Orange Arrow pointing towards center)
      const absRwDir = (vessel.heading + rwDir) % 360
      const radRw = absRwDir * Math.PI / 180
      const rwXStart = dx + (r - 2) * Math.sin(radRw)
      const rwYStart = dy - (r - 2) * Math.cos(radRw)
      const rwXEnd = dx + (r - 11) * Math.sin(radRw)
      const rwYEnd = dy - (r - 11) * Math.cos(radRw)

      ctx.strokeStyle = "#ff9900"
      ctx.lineWidth = 1.5
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.moveTo(rwXStart, rwYStart)
      ctx.lineTo(rwXEnd, rwYEnd)
      ctx.stroke()
      ctx.setLineDash([])

      // Draw Arrow Head for Relative Wind
      ctx.save()
      ctx.translate(rwXEnd, rwYEnd)
      ctx.rotate(radRw)
      ctx.fillStyle = "#ff9900"
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-2, 4)
      ctx.lineTo(2, 4)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      // Label 'R' next to start
      const rwLblX = dx + (r + 6) * Math.sin(radRw)
      const rwLblY = dy - (r + 6) * Math.cos(radRw)
      ctx.fillStyle = "#ff9900"
      ctx.font = "bold 7px Arial"
      ctx.fillText("R", rwLblX, rwLblY)
    }

  }, [vessel, mapZoom, averages, redrawTrigger])

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

  const handleWindSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    setWindSpeedVal(val)
    window.electronAPI.updateWindSpeed(val)
    window.electronAPI.saveConfig('vessel_wind_speed_set', val)
  }

  const handleWindDirChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    setWindDirVal(val)
    window.electronAPI.updateWindDir(val)
    window.electronAPI.saveConfig('vessel_wind_dir_set', val)
  }

  const handleDepthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    setDepthVal(val)
    window.electronAPI.updateDepthSet(val)
    window.electronAPI.saveConfig('vessel_depth_set', val)
  }

  const handleTempChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    setTempVal(val)
    window.electronAPI.updateTempSet(val)
    window.electronAPI.saveConfig('vessel_temp_set', val)
  }

  const handleZoomChange = (newZoom: number) => {
    const clamped = Math.max(100, Math.min(30000, newZoom))
    setMapZoom(clamped)
    window.electronAPI.saveConfig('vessel_zoom', clamped)
  }

  const handleZoomSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    handleZoomChange(val)
  }

  const handleBreadcrumbsToggle = () => {
    const next = !vessel.breadcrumbEnabled
    window.electronAPI.toggleVesselBreadcrumbs(next)
  }

  const handleSetCoords = (lat: number, lon: number) => {
    window.electronAPI.updateVesselCoords(lat, lon)
    setManualLat(lat.toString())
    setManualLon(lon.toString())
  }

  const handleUseGeolocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your operating system or computer.')
      return
    }

    setGeoLoading(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        handleSetCoords(latitude, longitude)
        setGeoLoading(false)
      },
      (error) => {
        alert(`Failed to retrieve current location: ${error.message}`)
        setGeoLoading(false)
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    )
  }

  const handleApplyManualCoords = () => {
    const lat = parseFloat(manualLat)
    const lon = parseFloat(manualLon)
    if (isNaN(lat) || lat < -90 || lat > 90) {
      alert('Please enter a valid Latitude between -90 and 90.')
      return
    }
    if (isNaN(lon) || lon < -180 || lon > 180) {
      alert('Please enter a valid Longitude between -180 and 180.')
      return
    }
    handleSetCoords(lat, lon)
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
      sentences: selectedSentences,
      paused: false
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
        <div className="flex items-center gap-2 flex-grow max-w-[260px]">
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

        {/* Circular Heading Slider */}
        <div className="flex items-center gap-2 select-none">
          <span className="text-xs text-gray-400 font-semibold shrink-0">Vessel Heading:</span>
          <div className="relative flex items-center gap-1.5">
            <svg
              ref={dialRef}
              onMouseDown={handleHeadingPointerDown}
              onTouchStart={handleHeadingPointerDown}
              width="36"
              height="36"
              className="cursor-pointer overflow-visible select-none touch-none"
            >
              {/* Compass Ring */}
              <circle cx="18" cy="18" r="14" fill="#0b1329" stroke="#334155" strokeWidth="2" />
              
              {/* Pointing Needle & Knob Handle */}
              {(() => {
                const r = 14
                const rad = (vessel.heading * Math.PI) / 180
                const kX = 18 + r * Math.sin(rad)
                const kY = 18 - r * Math.cos(rad)
                return (
                  <>
                    <line x1="18" y1="18" x2={kX} y2={kY} stroke="#ff4500" strokeWidth="2.5" strokeLinecap="round" />
                    <circle cx={kX} cy={kY} r="4" fill="#f97316" stroke="#ffffff" strokeWidth="1" />
                  </>
                )
              })()}
            </svg>
            <span className="text-xs font-mono font-bold text-orange-400 w-10 text-right">{vessel.heading.toFixed(0)}°</span>
          </div>
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

          <div className="flex-grow flex flex-col justify-center font-mono text-[10px] text-gray-300 gap-1 px-1 overflow-y-auto max-h-56 shrink-0 border border-gray-800 p-2 rounded bg-gray-950/40">
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Latitude:</span>
              <span className="text-gray-100 font-bold">{vessel.lat.toFixed(6)}° N</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Longitude:</span>
              <span className="text-gray-100 font-bold">{vessel.lon.toFixed(6)}° W</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Vess Speed:</span>
              <span className="text-gray-100 font-bold">{vessel.speed.toFixed(2)} kts</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Heading:</span>
              <span className="text-gray-100 font-bold">{vessel.heading.toFixed(1)}°</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Floor Depth:</span>
              <span className="text-gray-100 font-bold">{vessel.depth.toFixed(1)} m</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Water Temp:</span>
              <span className="text-gray-100 font-bold">{(vessel.waterTemp ?? 12.0).toFixed(1)} °C</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>True Wind:</span>
              <span className="text-gray-100 font-bold">{(vessel.windSpeedActive ?? 5.0).toFixed(1)} kts @ {(vessel.windDirActive ?? 240.0).toFixed(1)}°</span>
            </div>
            <div className="flex justify-between border-b border-gray-800/40 pb-0.5">
              <span>Rel Wind:</span>
              <span className="text-gray-100 font-bold">{(vessel.windSpeedRelative ?? 5.0).toFixed(1)} kts @ {(vessel.windDirRelative ?? 240.0).toFixed(1)}°</span>
            </div>
            <div className="flex justify-between">
              <span>Area Swept:</span>
              <span className="text-emerald-400 font-bold">{vessel.sweptArea.toFixed(2)} ha</span>
            </div>
          </div>

          {/* Environmental Setpoints Box */}
          <div className="mt-3 bg-gray-900/50 p-2.5 rounded-lg border border-gray-800 flex flex-col gap-2 shrink-0">
            <h5 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-800 pb-1">
              Environmental Setpoints
            </h5>
            
            {/* Wind Speed */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-[9px] font-bold text-gray-500 uppercase">
                <span>Wind Speed</span>
                <span className="text-orange-400 font-mono font-bold">{windSpeedVal.toFixed(1)} kts</span>
              </div>
              <input
                type="range"
                min="0"
                max="50"
                step="0.1"
                value={windSpeedVal}
                onChange={handleWindSpeedChange}
                className="w-full accent-orange-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
              />
            </div>

            {/* Wind Dir */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-[9px] font-bold text-gray-500 uppercase">
                <span>Wind Direction</span>
                <span className="text-orange-400 font-mono font-bold">{windDirVal.toFixed(0)}°</span>
              </div>
              <input
                type="range"
                min="0"
                max="359.9"
                step="1"
                value={windDirVal}
                onChange={handleWindDirChange}
                className="w-full accent-orange-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
              />
            </div>

            {/* Depth setpoint */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-[9px] font-bold text-gray-500 uppercase">
                <span>Sim Seafloor Depth</span>
                <span className="text-orange-400 font-mono font-bold">{depthVal.toFixed(0)} m</span>
              </div>
              <input
                type="range"
                min="10"
                max="1000"
                step="1"
                value={depthVal}
                onChange={handleDepthChange}
                className="w-full accent-orange-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
              />
            </div>

            {/* Temp setpoint */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-[9px] font-bold text-gray-500 uppercase">
                <span>Water Temperature</span>
                <span className="text-orange-400 font-mono font-bold">{tempVal.toFixed(1)} °C</span>
              </div>
              <input
                type="range"
                min="-2"
                max="40"
                step="0.1"
                value={tempVal}
                onChange={handleTempChange}
                className="w-full accent-orange-500 cursor-pointer h-1 bg-gray-800 rounded-lg appearance-none"
              />
            </div>
          </div>

          {/* Coordinates Setting Box */}
          <div className="mt-4 bg-gray-900/50 p-3 rounded-lg border border-gray-800 flex flex-col gap-2.5 shrink-0">
            <h5 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider border-b border-gray-800 pb-1">
              Set Vessel Coordinates
            </h5>

            {/* Presets */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Presets</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleSetCoords(33.60924687116191, -119.4452769936413)}
                  className="px-2 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 text-gray-200 rounded text-[10px] font-semibold transition cursor-pointer"
                >
                  Channel Islands
                </button>
                <button
                  onClick={() => handleSetCoords(44.63919065604716, -124.3498711799516)}
                  className="px-2 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-500 text-gray-200 rounded text-[10px] font-semibold transition cursor-pointer"
                >
                  Newport
                </button>
              </div>
            </div>

            {/* Geolocation */}
            <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-2">
              <button
                onClick={handleUseGeolocation}
                disabled={geoLoading}
                className="w-full px-2 py-1 bg-blue-950/40 hover:bg-blue-900/40 border border-blue-800 hover:border-blue-600 disabled:opacity-50 text-blue-300 rounded text-[10px] font-semibold transition cursor-pointer flex items-center justify-center gap-1"
              >
                {geoLoading ? 'Fetching Location...' : 'Use My Current Location'}
              </button>
            </div>

            {/* Manual Entry */}
            <div className="flex flex-col gap-1.5 border-t border-gray-800/60 pt-2">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Manual Entry</span>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-0.5 font-mono">
                  <span className="text-[8px] font-bold text-gray-600">LATITUDE</span>
                  <input
                    type="number"
                    step="0.000001"
                    value={manualLat}
                    onChange={(e) => setManualLat(e.target.value)}
                    placeholder="e.g. 33.6092"
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none focus:border-orange-500 font-mono w-full"
                  />
                </div>
                <div className="flex flex-col gap-0.5 font-mono">
                  <span className="text-[8px] font-bold text-gray-600">LONGITUDE</span>
                  <input
                    type="number"
                    step="0.000001"
                    value={manualLon}
                    onChange={(e) => setManualLon(e.target.value)}
                    placeholder="e.g. -119.4452"
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none focus:border-orange-500 font-mono w-full"
                  />
                </div>
              </div>
              <button
                onClick={handleApplyManualCoords}
                className="w-full mt-1 px-2 py-1 bg-orange-950/40 hover:bg-orange-900/40 border border-orange-800 hover:border-orange-600 text-orange-300 rounded text-[10px] font-semibold transition cursor-pointer"
              >
                Apply Coordinates
              </button>
            </div>
          </div>
        </div>

        {/* COLUMN 2: Native GIS Map Canvas */}
        <div className="col-span-4 border border-gray-800/60 bg-gray-950 rounded-lg overflow-hidden flex flex-col relative">
          <canvas
            ref={canvasRef}
            className="flex-grow w-full h-full block"
            onWheel={(e) => {
              e.preventDefault()
              const delta = -e.deltaY
              const zoomFactor = delta > 0 ? 1.15 : 0.85
              handleZoomChange(mapZoom * zoomFactor)
            }}
          ></canvas>

          {/* Bottom Left Map Zoom Controls Overlay */}
          <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 shadow-md">
            <button
              onClick={() => handleZoomChange(mapZoom * 1.25)}
              title="Zoom In"
              className="w-7 h-7 flex items-center justify-center bg-gray-900/90 hover:bg-gray-800 border border-gray-800 hover:border-gray-600 rounded text-gray-200 hover:text-white font-bold text-md transition cursor-pointer select-none active:scale-95"
            >
              +
            </button>
            <button
              onClick={() => handleZoomChange(mapZoom / 1.25)}
              title="Zoom Out"
              className="w-7 h-7 flex items-center justify-center bg-gray-900/90 hover:bg-gray-800 border border-gray-800 hover:border-gray-600 rounded text-gray-200 hover:text-white font-bold text-md transition cursor-pointer select-none active:scale-95"
            >
              −
            </button>
          </div>
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

          {/* Active Ports List Header & Global Controls */}
          <div className="flex justify-between items-center mb-1 shrink-0">
            <span className="text-[10px] font-bold text-gray-500 uppercase">Active Broadcast Channels</span>
            {broadcastPorts.length > 0 && (
              <div className="flex gap-1.5">
                <button
                  onClick={() => setAllPortsPaused(false)}
                  className="px-1.5 py-0.5 bg-emerald-950/40 hover:bg-emerald-900/40 border border-emerald-800 text-emerald-400 rounded text-[9px] font-bold transition cursor-pointer"
                >
                  Resume All
                </button>
                <button
                  onClick={() => setAllPortsPaused(true)}
                  className="px-1.5 py-0.5 bg-amber-950/40 hover:bg-amber-900/40 border border-amber-800 text-amber-400 rounded text-[9px] font-bold transition cursor-pointer"
                >
                  Pause All
                </button>
              </div>
            )}
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
                        {p.paused ? (
                          <span className="text-gray-500 line-through">
                            {`${p.device} (${p.protocol}) -> ${label}`}
                          </span>
                        ) : (
                          `${p.device} (${p.protocol}) -> ${label}`
                        )}
                      </span>
                      <span className="text-[8px] text-gray-500">
                        {p.hz} Hz • {(p.sentences || []).join(', ')} {p.paused && <span className="text-amber-500 font-bold ml-1 uppercase">(Paused)</span>}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0 ml-2">
                      <button
                        onClick={() => togglePortPause(p.id, !!p.paused)}
                        className={`px-1.5 py-0.5 border ${
                          p.paused
                            ? 'border-emerald-800 bg-emerald-950/25 hover:bg-emerald-900 text-emerald-400'
                            : 'border-amber-800 bg-amber-950/25 hover:bg-amber-900 text-amber-400'
                        } rounded text-[9px] font-bold transition cursor-pointer shrink-0`}
                      >
                        {p.paused ? 'Resume' : 'Pause'}
                      </button>
                      <button
                        onClick={() => removePort(p.id)}
                        className="px-1.5 py-0.5 border border-rose-800 bg-rose-950/25 hover:bg-rose-900 rounded text-[9px] text-rose-400 font-bold transition cursor-pointer shrink-0"
                      >
                        Remove
                      </button>
                    </div>
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
