import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import dgram from 'node:dgram'
import dns from 'node:dns'
import child_process from 'node:child_process'
import os from 'node:os'
import http from 'node:http'

// Disable GPU shader cache to prevent cache lock or access denied (0x5) errors on startup on restricted Windows profiles
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// --- JSON Configuration Storage ---
const configPath = path.join(app.getPath('userData'), 'vessel_simulator_config.json')

function loadConfigData(): Record<string, any> {
  if (!fs.existsSync(configPath)) {
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

function saveConfigData(data: Record<string, any>) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('Error saving config:', err)
  }
}

// --- Global Application State ---
let mainWindow: BrowserWindow | null = null

const DEVICE_GROUPS: Record<string, string[]> = {
  "GPS": ["$GPGLL", "$GPHDT", "$GPRMC", "$GPVTG"],
  "ITI_Trawl_System": ["$IIDBS", "$IIGLL", "@IIHFB", "@IIMTW", "@IITDS", "@IITPT"],
  "Furuno_Attitude_Heave": ["$PFEC,GPatt", "$PFEC,GPhve"],
  "Echosounder_Depth_Temp": ["$SDDBS", "$SDDBT", "$SDDPT", "$SDMTW", "$YCMTW"],
  "$PSIMP,D1": ["$PSIMP,D1"],
  "$PSIMTV80": ["$PSIMTV80"],
  "$WIMWV": ["$WIMWV"]
}

const SENTENCE_TO_DEVICE: Record<string, string> = {}
for (const [device, sentences] of Object.entries(DEVICE_GROUPS)) {
  for (const s of sentences) {
    SENTENCE_TO_DEVICE[s] = device
  }
}

function calculate_destination(lat: number, lon: number, bearing: number, distance_m: number): [number, number] {
  const R = 6371000 // Earth radius in meters
  const latRad = (lat * Math.PI) / 180
  const lonRad = (lon * Math.PI) / 180
  const bearingRad = (bearing * Math.PI) / 180
  const d = distance_m / R

  const newLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(d) + Math.cos(latRad) * Math.sin(d) * Math.cos(bearingRad)
  )
  const newLonRad = lonRad + Math.atan2(
    Math.sin(bearingRad) * Math.sin(d) * Math.cos(latRad),
    Math.cos(d) - Math.sin(latRad) * Math.sin(newLatRad)
  )

  return [(newLatRad * 180) / Math.PI, (newLonRad * 180) / Math.PI]
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

interface PortRunnerInstance {
  interval: NodeJS.Timeout | null
  serFd?: number | null
  udpSocket?: dgram.Socket | null
  tcpServer?: net.Server | null
  connectedSockets?: Set<net.Socket>
}

const activeRunners: Record<string, PortRunnerInstance> = {}

function getPayloadForPort(portConfig: BroadcastPort): string {
  const outSentences: string[] = []
  let selectedHeaders = portConfig.sentences
  if (!selectedHeaders || selectedHeaders.length === 0) {
    selectedHeaders = DEVICE_GROUPS[portConfig.device] || []
  }
  for (const h of selectedHeaders) {
    const s = state.latest_sentences[h]
    if (s) {
      outSentences.push(s)
    }
  }
  return outSentences.join('')
}

function stopRunnerByResource(protocol: 'SERIAL' | 'UDP' | 'TCP', endpoint: string | number) {
  // UDP outbound broadcasting does not lock the local port, so multiple devices can stream to it concurrently.
  if (protocol === 'UDP') {
    return
  }

  for (const id of Object.keys(activeRunners)) {
    const portConfig = state.active_ports[id]
    if (portConfig) {
      if (portConfig.protocol === protocol) {
        if (protocol === 'SERIAL' && portConfig.comPort === endpoint) {
          logMessage(`[VesselSim] Conflict detected on ${endpoint}. Stopping old runner ${id}.`)
          stopPortRunner(id)
        } else if (protocol === 'TCP' && portConfig.netPort === endpoint) {
          logMessage(`[VesselSim] Conflict detected on port ${endpoint}. Stopping old runner ${id}.`)
          stopPortRunner(id)
        }
      }
    }
  }
}

function startPortRunner(portConfig: BroadcastPort) {
  if (activeRunners[portConfig.id]) {
    stopPortRunner(portConfig.id)
  }

  // Deconflict physical port collisions (COM or Network Ports)
  if (portConfig.protocol === 'SERIAL') {
    stopRunnerByResource('SERIAL', portConfig.comPort || '')
  } else {
    stopRunnerByResource(portConfig.protocol, portConfig.netPort || 10110)
  }

  const runner: PortRunnerInstance = {
    interval: null
  }

  const hz = portConfig.hz || 1
  const intervalMs = Math.floor(1000 / hz)

  if (portConfig.protocol === 'SERIAL') {
    const rawPort = portConfig.comPort || 'COM13'
    const portPath = process.platform === 'win32' ? `\\\\.\\${rawPort.toUpperCase()}` : rawPort
    try {
      runner.serFd = fs.openSync(portPath, 'r+')
      logMessage(`[VesselSim] Opened serial port ${rawPort} for broadcasting.`)
    } catch (err: any) {
      logMessage(`ERROR: Could not open serial port ${rawPort} for vessel broadcast: ${err.message}`)
      runner.serFd = null
    }

    runner.interval = setInterval(() => {
      const activePort = state.active_ports[portConfig.id]
      if (state.current_mode !== 'Simulation' || !activePort || activePort.paused || runner.serFd === null || runner.serFd === undefined) {
        return
      }

      const payload = getPayloadForPort(portConfig)
      if (payload) {
        try {
          fs.writeSync(runner.serFd, Buffer.from(payload, 'ascii'))
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('vessel-nmea', {
              protocol: portConfig.protocol,
              payload: payload
            })
          }
        } catch (err: any) {
          // Normal if peer is closed/disconnected
        }
      }
    }, intervalMs)

  } else if (portConfig.protocol === 'UDP') {
    const udpSocket = dgram.createSocket('udp4')
    const host = portConfig.host || '127.0.0.1'
    const netPort = portConfig.netPort || 10110

    udpSocket.bind(0, () => {
      try {
        if (host === '255.255.255.255' || host.endsWith('.255')) {
          udpSocket.setBroadcast(true)
        }
      } catch (err) {
        // ignore setBroadcast errors
      }
    })

    runner.udpSocket = udpSocket

    runner.interval = setInterval(() => {
      const activePort = state.active_ports[portConfig.id]
      if (state.current_mode !== 'Simulation' || !activePort || activePort.paused) {
        return
      }

      const payload = getPayloadForPort(portConfig)
      if (payload) {
        try {
          udpSocket.send(Buffer.from(payload, 'ascii'), netPort, host)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('vessel-nmea', {
              protocol: portConfig.protocol,
              payload: payload
            })
          }
        } catch (err) {
          // ignore send errors
        }
      }
    }, intervalMs)

  } else if (portConfig.protocol === 'TCP') {
    const netPort = portConfig.netPort || 10110
    const host = portConfig.host || '127.0.0.1'
    const connectedSockets = new Set<net.Socket>()

    const server = net.createServer((socket) => {
      connectedSockets.add(socket)
      socket.on('close', () => connectedSockets.delete(socket))
      socket.on('error', () => connectedSockets.delete(socket))
    })

    server.listen(netPort, host, () => {
      logMessage(`[VesselSim] TCP Server listening on ${host}:${netPort} for ${portConfig.device}`)
    })

    server.on('error', (err: any) => {
      logMessage(`[VesselSim] TCP Server Error on port ${netPort}: ${err.message}`)
    })

    runner.tcpServer = server
    runner.connectedSockets = connectedSockets

    runner.interval = setInterval(() => {
      const activePort = state.active_ports[portConfig.id]
      if (state.current_mode !== 'Simulation' || !activePort || activePort.paused) {
        return
      }

      const payload = getPayloadForPort(portConfig)
      if (payload) {
        if (connectedSockets.size > 0) {
          const buf = Buffer.from(payload, 'ascii')
          for (const s of connectedSockets) {
            try {
              s.write(buf)
            } catch {
              // Socket write failed, will be deleted on close/error
            }
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('vessel-nmea', {
            protocol: portConfig.protocol,
            payload: payload
          })
        }
      }
    }, intervalMs)
  }

  activeRunners[portConfig.id] = runner
}

function stopPortRunner(id: string) {
  const runner = activeRunners[id]
  if (!runner) return

  if (runner.interval) {
    clearInterval(runner.interval)
  }

  if (runner.serFd !== null && runner.serFd !== undefined) {
    try {
      fs.closeSync(runner.serFd)
    } catch {
      // ignore
    }
  }

  if (runner.udpSocket) {
    try {
      runner.udpSocket.close()
    } catch {
      // ignore
    }
  }

  if (runner.tcpServer) {
    try {
      runner.tcpServer.close()
    } catch {
      // ignore
    }
    if (runner.connectedSockets) {
      for (const s of runner.connectedSockets) {
        try {
          s.destroy()
        } catch {
          // ignore
        }
      }
      runner.connectedSockets.clear()
    }
  }

  delete activeRunners[id]
  if (state.active_ports[id]) {
    delete state.active_ports[id]
  }
  logMessage(`[VesselSim] Stopped broadcast runner for ID: ${id}`)
}

const state = {
  vessel: {
    lat: 38.035,
    lon: -123.394,
    sog_knots: 0.0,
    heading: 0.0,
    track: 0.0,
    seafloor_depth: 300.0,
    pitch: 0.0,
    roll: 0.0,
    heave: 0.0,
    area_swept_kpi: 0.0,
    default_speed: 10.0,
    breadcrumb_enabled: true,
    // Setpoints
    wind_speed_set: 5.0,
    wind_dir_set: 240.0,
    depth_set: 300.0,
    temp_set: 12.0,
    // Active values
    wind_speed: 5.0,
    wind_dir: 240.0,
    water_temp: 12.0,
    wind_speed_relative: 5.0,
    wind_dir_relative: 240.0
  },
  track_history: [] as Array<[number, number, number]>,
  latest_sentences: {} as Record<string, string>,
  active_ports: {} as Record<string, BroadcastPort>,
  current_mode: 'Idle',
  clear_history() {
    this.track_history = []
  }
}

// Load initial setpoint values from config if present
try {
  const config = loadConfigData()
  state.vessel.default_speed = parseFloat(config.vessel_speed || '10')
  state.vessel.wind_speed_set = parseFloat(config.vessel_wind_speed_set || '5')
  state.vessel.wind_dir_set = parseFloat(config.vessel_wind_dir_set || '240')
  state.vessel.depth_set = parseFloat(config.vessel_depth_set || '300')
  state.vessel.temp_set = parseFloat(config.vessel_temp_set || '12')
  // Sync active values
  state.vessel.wind_speed = state.vessel.wind_speed_set
  state.vessel.wind_dir = state.vessel.wind_dir_set
  state.vessel.seafloor_depth = state.vessel.depth_set
  state.vessel.water_temp = state.vessel.temp_set
} catch {
  // ignore, use defaults
}

// Thread / interval states
let simInterval: NodeJS.Timeout | null = null
const serverInstances: Record<number, any> = {}
const stopFlags: Record<number, boolean> = {}

// Forwarding stream instances
const telemetryCOMRunning: Record<number, boolean> = {}
const telemetryUDPRunning: Record<number, boolean> = {}

// Printer listener states
const printerRunning: Record<string, boolean> = {}

function logMessage(msg: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', msg)
  }
}

// --- Window Lifecycle ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1326,
    height: 1050,
    icon: process.env.VITE_DEV_SERVER_URL
      ? path.join(__dirname, '../../serial_port.ico')
      : path.join(__dirname, '../dist/serial_port.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Disable default menu
  mainWindow.setMenu(null)

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    cleanupThreads()
  })
}

app.whenReady().then(() => {
  createWindow()

  // Load existing broadcast ports on startup, sanitize legacy formats, and start their runners
  try {
    const config = loadConfigData()
    if (config.vessel_ports && Array.isArray(config.vessel_ports)) {
      const sanitizedList: BroadcastPort[] = []
      for (const p of config.vessel_ports) {
        const deviceName = p.device || 'GPS'
        const defaultSentences = DEVICE_GROUPS[deviceName] || []
        const mappedProto = p.protocol || 'UDP'

        const rawPort = p.comPort || (mappedProto === 'SERIAL' ? (p.port ? `COM${p.port - 6000}` : 'COM13') : undefined)
        const netPort = p.netPort || (mappedProto !== 'SERIAL' ? (p.port || 10110) : undefined)
        const endpoint = mappedProto === 'SERIAL' ? rawPort : netPort
        const deterministicId = `${mappedProto}_${endpoint}_${deviceName}`.replace(/[^a-zA-Z0-9_]/g, '_')

        const sanitized: BroadcastPort = {
          ...p,
          id: p.id || deterministicId,
          sentences: p.sentences || defaultSentences,
          protocol: mappedProto,
          comPort: p.comPort || (mappedProto === 'SERIAL' ? (p.port ? `COM${p.port - 6000}` : 'COM13') : undefined),
          netPort: p.netPort || (mappedProto !== 'SERIAL' ? (p.port || 10110) : undefined),
          host: p.host || '127.0.0.1',
          paused: p.paused !== undefined ? p.paused : false
        }

        sanitizedList.push(sanitized)

        // Crucial: Register in state active_ports BEFORE starting runner so setInterval immediately has access to it!
        state.active_ports[sanitized.id] = sanitized

        startPortRunner(sanitized)
      }

      // Update config store immediately with cleaned data so legacy formats are migrated forever
      config.vessel_ports = sanitizedList
      saveConfigData(config)
    }
  } catch (err) {
    console.error('Error starting initial port runners on boot:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function cleanupThreads() {
  if (simInterval) {
    clearInterval(simInterval)
    simInterval = null
  }
  for (const id of Object.keys(activeRunners)) {
    stopPortRunner(id)
  }
}

// --- IPC Configuration Handlers ---
ipcMain.handle('load-config', () => {
  return loadConfigData()
})

ipcMain.on('save-config', (_event, { key, value }) => {
  const current = loadConfigData()
  current[key] = value
  saveConfigData(current)
})

ipcMain.handle('get-available-ports', () => {
  // Return standard virtual/physical ports list
  const detected: string[] = []
  const virtual = [
    ...Array.from({ length: 26 }, (_, i) => `COM${100 + i}`),
    ...Array.from({ length: 26 }, (_, i) => `COM${200 + i}`)
  ]
  return [...detected, ...virtual]
})

// --- NMEA-0183 CHECKSUM & FORMATTERS ---
function generateChecksum(sentence: string): string {
  if (sentence.startsWith('$') || sentence.startsWith('@') || sentence.startsWith('!')) {
    sentence = sentence.substring(1)
  }
  let checksum = 0
  for (let i = 0; i < sentence.length; i++) {
    checksum ^= sentence.charCodeAt(i)
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0')
}

function decimalToNmeaLat(decLat: number): [string, string] {
  const direction = decLat >= 0 ? 'N' : 'S'
  const absLat = Math.abs(decLat)
  const degrees = Math.floor(absLat)
  const minutes = (absLat - degrees) * 60
  const minStr = minutes.toFixed(4).padStart(7, '0')
  return [`${degrees.toString().padStart(2, '0')}${minStr}`, direction]
}

function decimalToNmeaLon(decLon: number): [string, string] {
  const direction = decLon >= 0 ? 'E' : 'W'
  const absLon = Math.abs(decLon)
  const degrees = Math.floor(absLon)
  const minutes = (absLon - degrees) * 60
  const minStr = minutes.toFixed(4).padStart(7, '0')
  return [`${degrees.toString().padStart(3, '0')}${minStr}`, direction]
}

// --- NMEA SENTENCE GENERATORS ---
const GENERATORS: Record<string, () => string | string[]> = {
  '$GPGLL': () => {
    const [latStr, latDir] = decimalToNmeaLat(state.vessel.lat)
    const [lonStr, lonDir] = decimalToNmeaLon(state.vessel.lon)
    const now = new Date()
    const timeStr = now.toISOString().split('T')[1].replace(/[:Z]/g, '').substring(0, 6) + '.00'
    const body = `GPGLL,${latStr},${latDir},${lonStr},${lonDir},${timeStr},A,A`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$GPHDT': () => {
    const body = `GPHDT,${state.vessel.heading.toFixed(1)},T`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$GPRMC': () => {
    const [latStr, latDir] = decimalToNmeaLat(state.vessel.lat)
    const [lonStr, lonDir] = decimalToNmeaLon(state.vessel.lon)
    const now = new Date()
    const timeStr = now.toISOString().split('T')[1].replace(/[:Z]/g, '').substring(0, 6)
    const dateStr = now.toISOString().split('T')[0].split('-').reverse().join('').substring(0, 6)
    const body = `GPRMC,${timeStr},A,${latStr},${latDir},${lonStr},${lonDir},${state.vessel.sog_knots.toFixed(2)},${state.vessel.track.toFixed(1)},${dateStr},,,A`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$GPVTG': () => {
    const body = `GPVTG,${state.vessel.track.toFixed(1)},T,,M,${state.vessel.sog_knots.toFixed(2)},N,${(state.vessel.sog_knots * 1.852).toFixed(2)},K,A`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$IIDBS': () => {
    const depth = state.vessel.seafloor_depth - (Math.random() * 15 + 5)
    const body = `IIDBS,${depth.toFixed(1)},M`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$IIGLL': () => {
    const [latStr, latDir] = decimalToNmeaLat(state.vessel.lat - 0.0005)
    const [lonStr, lonDir] = decimalToNmeaLon(state.vessel.lon - 0.0005)
    const now = new Date()
    const timeStr = now.toISOString().split('T')[1].replace(/[:Z]/g, '').substring(0, 6) + '.00'
    const body = `IIGLL,${latStr},${latDir},${lonStr},${lonDir},${timeStr},A`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '@IIHFB': () => {
    const val1 = Math.random() * 3 + 4
    const val2 = Math.random() * 4 + 1
    return `@IIHFB,${val1.toFixed(1)},M,${val2.toFixed(1)},M\r\n`
  },
  '@IIMTW': () => {
    return `@IIMTW,${state.vessel.water_temp.toFixed(1)},C\r\n`
  },
  '@IITDS': () => {
    const val = Math.random() * 35 + 40
    return `@IITDS,${val.toFixed(1)},M\r\n`
  },
  '@IITPT': () => {
    const dist = Math.random() * 300 + 300
    const trk = (state.vessel.heading + 180) % 360
    const depth = state.vessel.seafloor_depth - (Math.random() * 15 + 5)
    return `@IITPT,${dist.toFixed(1)},M,${trk.toFixed(1)},T,${depth.toFixed(1)},M\r\n`
  },
  '$PFEC,GPatt': () => {
    const body = `PFEC,GPatt,${state.vessel.heading.toFixed(2)},${state.vessel.pitch.toFixed(2)},${state.vessel.roll.toFixed(2)}`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$PFEC,GPhve': () => {
    const body = `PFEC,GPhve,${state.vessel.heave.toFixed(2)},A`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$PSIMP,D1': () => {
    const now = new Date()
    const timeStr = now.toISOString().split('T')[1].replace(/[:Z]/g, '').substring(0, 6) + '.000'
    const dateStr = now.toISOString().split('T')[0].split('-').reverse().join('').substring(0, 6)
    const base = ["PSIMP", "D1", timeStr, dateStr]
    const p1 = [...base, "H1", "M", "1", "1", "2", `${(Math.random() * 2 + 14).toFixed(2)}`, "0.0", "21", "0", "60.0", "30.0", "20.0", "0", "0"].join(',')
    const p2 = [...base, "S1", "M", "1", "1", "4", `${(Math.random() * 2 + 14).toFixed(2)}`, "0.0", "21", "0", "60.0", "30.0", "20.0", "0", "0"].join(',')
    const p3 = [...base, "S1", "M", "1", "1", "6", `${(Math.random() * 5 + 32).toFixed(2)}`, "0.0", "21", "0", "60.0", "30.0", "20.0", "0", "0"].join(',')
    const p4 = [...base, "D1", "M", "1", "1", "8", `${(state.vessel.seafloor_depth + 15).toFixed(2)}`, "0.0", "21", "0", "60.0", "30.0", "20.0", "0", "0"].join(',')
    return [
      `$${p1}*${generateChecksum(p1)}\r\n`,
      `$${p2}*${generateChecksum(p2)}\r\n`,
      `$${p3}*${generateChecksum(p3)}\r\n`,
      `$${p4}*${generateChecksum(p4)}\r\n`
    ]
  },
  '$PSIMTV80': () => {
    const now = new Date()
    const timeStr = now.toISOString().split('T')[1].replace(/[:Z]/g, '').substring(0, 6)
    const dateStr = now.toISOString().split('T')[0].split('-').reverse().join('').substring(0, 6)
    const base = ["PSIMTV80", timeStr, dateStr, "", "", "", "", "", "", "", "", "", "", "", ""]
    const p1 = [...base, "03", "a7", "", `${(state.vessel.seafloor_depth - 15).toFixed(2)}`, "10", "0"].join(',')
    const p2 = [...base, "12", "a7", "", `${(Math.random() * 2 + 14).toFixed(2)}`, "10", "0"].join(',')
    const p3 = [...base, "01", "a5", "a6", `${(Math.random() * 1.5 + 13).toFixed(2)}`, "10", "0"].join(',')
    return [
      `$${p1}*${generateChecksum(p1)}\r\n`,
      `$${p2}*${generateChecksum(p2)}\r\n`,
      `$${p3}*${generateChecksum(p3)}\r\n`
    ]
  },
  '$SDDBS': () => {
    const d = state.vessel.seafloor_depth
    const body = `SDDBS,${(d * 3.28).toFixed(1)},f,${d.toFixed(1)},M,${(d * 0.54).toFixed(1)},F`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$SDDBT': () => {
    const d = state.vessel.seafloor_depth
    const body = `SDDBT,${(d * 3.28).toFixed(1)},f,${d.toFixed(1)},M,${(d * 0.54).toFixed(1)},F`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$SDDPT': () => {
    const d = state.vessel.seafloor_depth
    const body = `SDDPT,${d.toFixed(1)},0.0`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$SDMTW': () => {
    const body = `SDMTW,${state.vessel.water_temp.toFixed(1)},C`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$YCMTW': () => {
    const body = `YCMTW,${state.vessel.water_temp.toFixed(1)},C`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$WIMWV': () => {
    const t_dir = state.vessel.wind_dir
    const t_spd = state.vessel.wind_speed
    const r_ang = state.vessel.wind_dir_relative
    const r_spd = state.vessel.wind_speed_relative
    const t_body = `WIMWV,${t_dir.toFixed(1)},T,${t_spd.toFixed(1)},N,A`
    const r_body = `WIMWV,${r_ang.toFixed(1)},R,${r_spd.toFixed(1)},N,A`
    return `$${t_body}*${generateChecksum(t_body)}\r\n` + `$${r_body}*${generateChecksum(r_body)}\r\n`
  }
}

// --- TAB 1: NATIVE COM DEVICE WRITER ---
ipcMain.on('send-device-data', (_event, { device, value, port, baud }) => {
  // Format device NMEA sentences
  let sentence = ''
  if (device.includes('Marel')) {
    sentence = `${parseFloat(value).toFixed(2).padStart(8)} kg  0.00 kg\r\n`
  } else if (device === 'Scantrol FM-100') {
    const val = parseFloat(value).toFixed(1)
    sentence = ' '.repeat(32) + val.padEnd(6).substring(0, 6) + '\r\n'
  } else if (device === 'IchthyStick v3') {
    sentence = parseFloat(value).toFixed(1).padEnd(4).substring(0, 4) + '\r\n'
  } else {
    sentence = `${value}\r\n`
  }

  const payload = Buffer.from(sentence, 'ascii')
  const portPath = process.platform === 'win32' ? `\\\\.\\${port.toUpperCase()}` : port

  try {
    // Zero native dependencies write logic
    const fd = fs.openSync(portPath, 'r+')
    fs.writeSync(fd, payload)
    fs.closeSync(fd)
    logMessage(`[${port} @ ${baud}] ${device} -> ${JSON.stringify(sentence)}`)
  } catch (err: any) {
    logMessage(`ERROR: Could not write to ${port}. (Pair may not be listening)`)
  }
})

// --- PRINTER EMBEDDED LISTENERS ---
ipcMain.on('toggle-printer-listener', (_event, { printer, port, baud, active }) => {
  const portPath = process.platform === 'win32' ? `\\\\.\\${port.toUpperCase()}` : port

  if (!active) {
    printerRunning[printer] = false
    logMessage(`Stopped listener for ${printer}`)
    return
  }

  printerRunning[printer] = true
  logMessage(`Started listener for ${printer} on ${port} @ ${baud}`)

  // Start serial non-blocking poller in a thread simulation
  let fd: number | null = null
  try {
    fd = fs.openSync(portPath, 'r')
  } catch (err: any) {
    logMessage(`ERROR: Could not listen on printer port ${port}: ${err.message}`)
    printerRunning[printer] = false
    return
  }

  const buffer = Buffer.alloc(4096)
  let accumulated = ''

  const poll = () => {
    if (!printerRunning[printer] || fd === null) {
      if (fd !== null) {
        fs.closeSync(fd)
      }
      return
    }

    try {
      const bytesRead = fs.readSync(fd, buffer, 0, 4096, null)
      if (bytesRead > 0) {
        accumulated += buffer.toString('utf8', 0, bytesRead)
        if (accumulated.includes('P1') || accumulated.includes('\nP')) {
          // Parse EPL text lines
          const display: string[] = []
          const lines = accumulated.split(/\r?\n/)
          for (const line of lines) {
            if (line.startsWith('A') && line.includes('"')) {
              const m = line.match(/"([^"]*)"/)
              if (m) display.push(m[1])
            } else if (line.startsWith('B') && line.includes('"')) {
              const m = line.match(/"([^"]*)"/)
              if (m) {
                display.push('--------------------------')
                display.push(`||| |||||| | ||||| ||||||\n    *${m[1]}*`)
                display.push('--------------------------')
              }
            }
          }
          accumulated = ''
          const labelOutput = display.join('\n') || '<Raw EPL Job parsed>'
          mainWindow?.webContents.send('printer-label', { printer, label: labelOutput })
          logMessage(`[${printer}] Printed label job successfully.`)
        }
      }
    } catch {
      // Normal if buffer is dry
    }

    setTimeout(poll, 100)
  }

  poll()
})

// --- TAB 2: TELEMETRY CONNECTIVITY TEST ---
ipcMain.on('test-connection', (_event, ip) => {
  logMessage(`Testing connection to ${ip}...`)
  dns.lookup(ip, (err) => {
    if (err) {
      logMessage(`ERROR: Could not resolve IP/Host: ${ip}`)
      mainWindow?.webContents.send('connection-test-result', { success: false, msg: `Failed resolving host ${ip}` })
      return
    }

    // Attempt standard SSH or TCP connection test
    const s = net.createConnection({ host: ip, port: 22, timeout: 2000 }, () => {
      s.destroy()
      const msg = `Host ${ip} is reachable on Port 22!`
      logMessage(msg)
      mainWindow?.webContents.send('connection-test-result', { success: true, msg })
    })

    s.on('error', (ex) => {
      const msg = `Host ${ip} is reachable (resolved), but Port 22 was refused/timed out: ${ex.message}`
      logMessage(msg)
      mainWindow?.webContents.send('connection-test-result', { success: true, msg })
    })
  })
})

// --- TELEMETRY COM/UDP FORWARDING BRIDGES ---
ipcMain.on('toggle-telemetry-com', (_event, { mappingId, tcpPort, comPort, baudRate, active }) => {
  const key = mappingId
  if (!active) {
    telemetryCOMRunning[key] = false
    mainWindow?.webContents.send('telemetry-status', { type: 'com', id: mappingId, status: 'grey' })
    return
  }

  telemetryCOMRunning[key] = true
  mainWindow?.webContents.send('telemetry-status', { type: 'com', id: mappingId, status: 'yellow' })

  const config = loadConfigData()
  const serverIp = config.server_ip || '161.55.52.50'
  const comPath = process.platform === 'win32' ? `\\\\.\\${comPort.toUpperCase()}` : comPort

  let serFd: number | null = null
  try {
    serFd = fs.openSync(comPath, 'r+')
    logMessage(`[TCP:${tcpPort} -> ${comPort}] Successfully opened serial path`)
  } catch (err: any) {
    logMessage(`ERROR: Could not open com0com bridge port ${comPort}: ${err.message}`)
    mainWindow?.webContents.send('telemetry-status', { type: 'com', id: mappingId, status: 'red' })
    return
  }

  const client = net.createConnection({ host: serverIp, port: tcpPort, timeout: 5000 }, () => {
    logMessage(`[TCP:${tcpPort} -> ${comPort}] Connected to remote server IP.`)
    mainWindow?.webContents.send('telemetry-status', { type: 'com', id: mappingId, status: 'green' })
  })

  client.on('data', (chunk) => {
    if (!telemetryCOMRunning[key]) {
      client.destroy()
      return
    }

    try {
      if (serFd !== null) {
        fs.writeSync(serFd, chunk)
        const line = chunk.toString('ascii').trim()
        if (line.includes('$') || line.includes('!')) {
          mainWindow?.webContents.send('telemetry-stream-log', { type: 'com', text: line + '\r\n' })
        }
      }
    } catch {
      // Safe write ignore
    }
  })

  client.on('error', (err) => {
    logMessage(`[TCP:${tcpPort} -> ${comPort}] Bridge connection error: ${err.message}`)
    mainWindow?.webContents.send('telemetry-status', { type: 'com', id: mappingId, status: 'yellow' })
  })

  client.on('close', () => {
    if (serFd !== null) {
      fs.closeSync(serFd)
    }
    logMessage(`[TCP:${tcpPort} -> ${comPort}] Bridge stopped.`)
    mainWindow?.webContents.send('telemetry-status', { type: 'com', id: mappingId, status: 'grey' })
  })
})

ipcMain.on('toggle-telemetry-udp', (_event, { mappingId, tcpPort, udpIp, udpPort, active }) => {
  const key = mappingId
  if (!active) {
    telemetryUDPRunning[key] = false
    mainWindow?.webContents.send('telemetry-status', { type: 'udp', id: mappingId, status: 'grey' })
    return
  }

  telemetryUDPRunning[key] = true
  mainWindow?.webContents.send('telemetry-status', { type: 'udp', id: mappingId, status: 'yellow' })

  const config = loadConfigData()
  const serverIp = config.server_ip || '161.55.52.50'

  const udpSocket = dgram.createSocket('udp4')
  const client = net.createConnection({ host: serverIp, port: tcpPort, timeout: 5000 }, () => {
    logMessage(`[TCP:${tcpPort} -> UDP:${udpPort}] Connected to server IP.`)
    mainWindow?.webContents.send('telemetry-status', { type: 'udp', id: mappingId, status: 'green' })
  })

  client.on('data', (chunk) => {
    if (!telemetryUDPRunning[key]) {
      client.destroy()
      return
    }

    udpSocket.send(chunk, udpPort, udpIp, (err) => {
      if (!err) {
        const line = chunk.toString('ascii').trim()
        if (line.includes('$') || line.includes('!')) {
          mainWindow?.webContents.send('telemetry-stream-log', { type: 'udp', text: line + '\r\n' })
        }
      }
    })
  })

  client.on('error', (err) => {
    logMessage(`[TCP:${tcpPort} -> UDP:${udpPort}] Bridge error: ${err.message}`)
    mainWindow?.webContents.send('telemetry-status', { type: 'udp', id: mappingId, status: 'yellow' })
  })

  client.on('close', () => {
    udpSocket.close()
    logMessage(`[TCP:${tcpPort} -> UDP:${udpPort}] Bridge stopped.`)
    mainWindow?.webContents.send('telemetry-status', { type: 'udp', id: mappingId, status: 'grey' })
  })
})

// --- TAB 3: LOCAL VESSEL SIMULATION CORE ---
ipcMain.on('update-vessel-speed', (_event, speed) => {
  state.vessel.default_speed = parseFloat(speed)
  const config = loadConfigData()
  config.vessel_speed = speed.toString()
  saveConfigData(config)
})

ipcMain.on('update-wind-speed', (_event, speed) => {
  state.vessel.wind_speed_set = parseFloat(speed)
  const config = loadConfigData()
  config.vessel_wind_speed_set = speed.toString()
  saveConfigData(config)
})

ipcMain.on('update-wind-dir', (_event, dir) => {
  state.vessel.wind_dir_set = parseFloat(dir)
  const config = loadConfigData()
  config.vessel_wind_dir_set = dir.toString()
  saveConfigData(config)
})

ipcMain.on('update-depth-set', (_event, depth) => {
  state.vessel.depth_set = parseFloat(depth)
  const config = loadConfigData()
  config.vessel_depth_set = depth.toString()
  saveConfigData(config)
})

ipcMain.on('update-temp-set', (_event, temp) => {
  state.vessel.temp_set = parseFloat(temp)
  const config = loadConfigData()
  config.vessel_temp_set = temp.toString()
  saveConfigData(config)
})

ipcMain.on('toggle-vessel-breadcrumbs', (_event, enabled) => {
  state.vessel.breadcrumb_enabled = enabled
})

ipcMain.on('steer-left', () => {
  state.vessel.track = (state.vessel.track - 5 + 360) % 360
  state.vessel.heading = state.vessel.track
  logMessage(`[VesselSim] Steered 5° LEFT. New heading: ${state.vessel.track.toFixed(1)}°`)
})

ipcMain.on('steer-right', () => {
  state.vessel.track = (state.vessel.track + 5) % 360
  state.vessel.heading = state.vessel.track
  logMessage(`[VesselSim] Steered 5° RIGHT. New heading: ${state.vessel.track.toFixed(1)}°`)
})

ipcMain.on('update-vessel-heading', (_event, heading) => {
  const h = (parseFloat(heading) + 360) % 360
  state.vessel.track = h
  state.vessel.heading = h
  logMessage(`[VesselSim] Set heading directly to ${h.toFixed(1)}°`)
})

ipcMain.handle('toggle-vessel-port-pause', (_event, { id, paused }) => {
  const activePort = state.active_ports[id]
  if (activePort) {
    activePort.paused = paused
    
    const config = loadConfigData()
    const portsList: BroadcastPort[] = config.vessel_ports || []
    const idx = portsList.findIndex(p => p.id === id)
    if (idx >= 0) {
      portsList[idx].paused = paused
    }
    config.vessel_ports = portsList
    saveConfigData(config)
    
    return { success: true }
  }
  return { success: false, msg: 'Active port not found' }
})

ipcMain.handle('set-all-vessel-ports-paused', (_event, paused) => {
  for (const id of Object.keys(state.active_ports)) {
    state.active_ports[id].paused = paused
  }
  const config = loadConfigData()
  const portsList: BroadcastPort[] = config.vessel_ports || []
  for (const p of portsList) {
    p.paused = paused
  }
  config.vessel_ports = portsList
  saveConfigData(config)
  return { success: true }
})

ipcMain.on('update-vessel-coords', (_event, { lat, lon }) => {
  state.vessel.lat = parseFloat(lat)
  state.vessel.lon = parseFloat(lon)
  state.clear_history() // clear old historical crumbs so they reset to new starting location
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vessel-state', {
      mode: state.current_mode,
      lat: state.vessel.lat,
      lon: state.vessel.lon,
      speed: state.vessel.sog_knots,
      depth: state.vessel.seafloor_depth,
      sweptArea: state.vessel.area_swept_kpi,
      heading: state.vessel.heading,
      trackHistory: state.track_history,
      breadcrumbEnabled: state.vessel.breadcrumb_enabled
    })
  }
})

ipcMain.on('start-vessel-sim', () => {
  if (simInterval) {
    return
  }

  state.clear_history()
  state.current_mode = 'Simulation'
  logMessage('[VesselSim] 10Hz native simulation engine started.')

  state.vessel.track = Math.random() * 360
  state.vessel.heading = state.vessel.track
  let loopCounter = 0

  simInterval = setInterval(() => {
    let track = state.vessel.track
    // Kinematics updates
    const speedKts = state.vessel.default_speed * (Math.random() * 0.2 + 0.9)
    const metersPerSec = speedKts * 0.514444
    if (speedKts > 0) {
      track = (track + (Math.random() * 2 - 1) + 360) % 360
    }

    const [nLat, nLon] = calculate_destination(state.vessel.lat, state.vessel.lon, track, metersPerSec * 0.1)

    // Wander +/- 10% around base values
    const activeWindSpd = state.vessel.wind_speed_set * (Math.random() * 0.2 + 0.9)
    const activeWindDir = (state.vessel.wind_dir_set + (Math.random() * 10 - 5) + 360) % 360
    const activeDepth = state.vessel.depth_set * (Math.random() * 0.2 + 0.9)
    const activeTemp = state.vessel.temp_set * (Math.random() * 0.2 + 0.9)

    // Apparent wind vector math:
    const thetaTrueRel = (activeWindDir - track + 360) % 360
    const thetaTrueRelRad = (thetaTrueRel * Math.PI) / 180

    const xRel = activeWindSpd * Math.sin(thetaTrueRelRad)
    const yRel = activeWindSpd * Math.cos(thetaTrueRelRad) + speedKts

    const activeWindSpdRel = Math.sqrt(xRel * xRel + yRel * yRel)
    const activeWindDirRel = (Math.atan2(xRel, yRel) * 180 / Math.PI + 360) % 360

    state.vessel.lat = nLat
    state.vessel.lon = nLon
    state.vessel.sog_knots = speedKts
    state.vessel.track = track
    state.vessel.heading = track
    state.vessel.seafloor_depth = parseFloat(activeDepth.toFixed(1))
    state.vessel.water_temp = parseFloat(activeTemp.toFixed(1))
    state.vessel.wind_speed = parseFloat(activeWindSpd.toFixed(1))
    state.vessel.wind_dir = parseFloat(activeWindDir.toFixed(1))
    state.vessel.wind_speed_relative = parseFloat(activeWindSpdRel.toFixed(1))
    state.vessel.wind_dir_relative = parseFloat(activeWindDirRel.toFixed(1))

    state.vessel.pitch = Math.random() * 4 - 2
    state.vessel.roll = Math.random() * 8 - 4
    state.vessel.heave = Math.random() * 1 - 0.5

    if (loopCounter % 10 === 0) {
      state.track_history.push([nLat, nLon, track])
      if (state.track_history.length > 200) {
        state.track_history.shift()
      }
      state.vessel.area_swept_kpi += (metersPerSec * 15.0) / 10000.0
    }

    // Generate NMEA sentences
    const list: string[] = []
    for (const header of Object.keys(GENERATORS)) {
      const sentence = GENERATORS[header]()
      if (Array.isArray(sentence)) {
        list.push(...sentence)
        state.latest_sentences[header] = sentence.join('')
      } else {
        list.push(sentence)
        state.latest_sentences[header] = sentence
      }
    }

    // Poll coordinate readout to Renderer (1Hz)
    if (loopCounter % 10 === 0) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vessel-state', {
          mode: state.current_mode,
          lat: state.vessel.lat,
          lon: state.vessel.lon,
          speed: state.vessel.sog_knots,
          depth: state.vessel.seafloor_depth,
          sweptArea: state.vessel.area_swept_kpi,
          heading: state.vessel.heading,
          trackHistory: state.track_history,
          breadcrumbEnabled: state.vessel.breadcrumb_enabled,
          // Extra values
          waterTemp: state.vessel.water_temp,
          windSpeedSet: state.vessel.wind_speed_set,
          windDirSet: state.vessel.wind_dir_set,
          depthSet: state.vessel.depth_set,
          tempSet: state.vessel.temp_set,
          windSpeedActive: state.vessel.wind_speed,
          windDirActive: state.vessel.wind_dir,
          windSpeedRelative: state.vessel.wind_speed_relative,
          windDirRelative: state.vessel.wind_dir_relative
        })
      }
    }

    loopCounter++
  }, 100)
})

ipcMain.on('stop-vessel-sim', () => {
  if (simInterval) {
    clearInterval(simInterval)
    simInterval = null
  }
  state.current_mode = 'Idle'
  logMessage('[VesselSim] Simulator stopped.')
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vessel-state', {
      mode: state.current_mode,
      lat: state.vessel.lat,
      lon: state.vessel.lon,
      speed: 0,
      depth: state.vessel.seafloor_depth,
      sweptArea: state.vessel.area_swept_kpi,
      heading: state.vessel.heading,
      trackHistory: state.track_history,
      breadcrumbEnabled: state.vessel.breadcrumb_enabled,
      // Extra values
      waterTemp: state.vessel.water_temp,
      windSpeedSet: state.vessel.wind_speed_set,
      windDirSet: state.vessel.wind_dir_set,
      depthSet: state.vessel.depth_set,
      tempSet: state.vessel.temp_set,
      windSpeedActive: state.vessel.wind_speed,
      windDirActive: state.vessel.wind_dir,
      windSpeedRelative: state.vessel.wind_speed_relative,
      windDirRelative: state.vessel.wind_dir_relative
    })
  }
})

// --- VESSEL BROADCAST PORTS HANDLERS ---
ipcMain.handle('add-vessel-port', (_event, portConfig: BroadcastPort) => {
  try {
    if (!portConfig.id) {
      portConfig.id = Math.random().toString(36).substring(2, 9)
    }

    portConfig.paused = portConfig.paused !== undefined ? portConfig.paused : false

    // Crucial: Register in state active_ports BEFORE starting runner so setInterval immediately has access to it!
    state.active_ports[portConfig.id] = portConfig

    startPortRunner(portConfig)

    const config = loadConfigData()
    const portsList: BroadcastPort[] = config.vessel_ports || []
    
    const existingIndex = portsList.findIndex(p => p.id === portConfig.id)
    if (existingIndex >= 0) {
      portsList[existingIndex] = portConfig
    } else {
      portsList.push(portConfig)
    }
    
    config.vessel_ports = portsList
    saveConfigData(config)

    const label = portConfig.protocol === 'SERIAL'
      ? portConfig.comPort
      : `${portConfig.host}:${portConfig.netPort}`

    return { success: true, msg: `Configured ${portConfig.protocol} broadcast on ${label}` }
  } catch (err: any) {
    return { success: false, msg: `Failed adding broadcast port: ${err.message}` }
  }
})

ipcMain.handle('remove-vessel-port', (_event, id: string) => {
  try {
    stopPortRunner(id)

    if (state.active_ports[id]) {
      delete state.active_ports[id]
    }

    const config = loadConfigData()
    const portsList: BroadcastPort[] = config.vessel_ports || []
    const updated = portsList.filter(p => p.id !== id)
    config.vessel_ports = updated
    saveConfigData(config)

    return true
  } catch (err) {
    console.error('Failed removing port:', err)
    return false
  }
})

// --- TAB 5: NETWORK DIAGNOSTICS HANDLERS ---
ipcMain.handle('run-ping', async (_event, targetIp: string) => {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const cmd = 'ping'
    const args = isWin ? ['-n', '4', targetIp] : ['-c', '4', targetIp]

    const child = child_process.spawn(cmd, args, {
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout || stderr || `Ping finished with code ${code}`
      })
    })
  })
})

ipcMain.handle('map-drive', async (_event, { driveLetter, targetIp }) => {
  return new Promise((resolve) => {
    const uncPath = `\\\\${targetIp}\\c`
    
    child_process.exec(`net use ${driveLetter}: /delete /y`, { windowsHide: true }, () => {
      child_process.exec(`net use ${driveLetter}: "${uncPath}" /persistent:yes`, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, output: stderr || stdout || err.message })
        } else {
          resolve({ success: true, output: stdout || `Mapped ${driveLetter}: drive to ${uncPath} successfully.` })
        }
      })
    })
  })
})

ipcMain.handle('run-drive-speed-test', async (_event, { path: drivePath, sizeMb }) => {
  let targetDir = drivePath
  
  if (drivePath === 'C:\\' || drivePath === 'C:/') {
    targetDir = app.getPath('temp')
  }

  try {
    if (!fs.existsSync(targetDir)) {
      return { success: false, speedMbSec: 0, duration: 0, msg: `Drive path not accessible: ${drivePath}` }
    }
  } catch (err: any) {
    return { success: false, speedMbSec: 0, duration: 0, msg: `Drive path access denied: ${err.message}` }
  }

  const testFileLocal = path.join(app.getPath('temp'), `diag_local_test_${sizeMb}mb.tmp`)
  const testFileTarget = path.join(targetDir, `diag_vessel_speed_test_${sizeMb}mb.tmp`)

  try {
    // Generate buffer
    const buf = Buffer.alloc(sizeMb * 1024 * 1024, 0xAF)
    fs.writeFileSync(testFileLocal, buf)

    const startTime = Date.now()
    fs.copyFileSync(testFileLocal, testFileTarget)
    const durationSec = (Date.now() - startTime) / 1000

    try { fs.unlinkSync(testFileLocal) } catch {}
    try { fs.unlinkSync(testFileTarget) } catch {}

    const speedSec = sizeMb / durationSec
    return {
      success: true,
      speedMbSec: parseFloat(speedSec.toFixed(2)),
      duration: parseFloat(durationSec.toFixed(2)),
      msg: `Write succeeded. Speed: ${speedSec.toFixed(2)} MB/s (${durationSec.toFixed(2)}s)`
    }
  } catch (err: any) {
    try { fs.unlinkSync(testFileLocal) } catch {}
    try { fs.unlinkSync(testFileTarget) } catch {}
    return { success: false, speedMbSec: 0, duration: 0, msg: `Write test failed: ${err.message}` }
  }
})

ipcMain.handle('export-diag-logs', async (_event, { summary, details }) => {
  try {
    const downloadsDir = path.join(os.homedir(), 'Downloads')
    const timestamp = new Date().toISOString().replace(/[:T]/g, '-').substring(0, 19)
    const filename = `Vessel_Diagnostics_${timestamp}.txt`
    const filepath = path.join(downloadsDir, filename)

    let content = "=== VESSEL DIAGNOSTICS REPORT ===\n"
    content += `Generated: ${new Date().toLocaleString()}\n`
    content += "=================================\n\n"
    content += "--- SUMMARY RESULTS ---\n"
    content += summary
    content += "\n\n--- DETAILED LOGS ---\n"
    content += details

    fs.writeFileSync(filepath, content, 'utf8')
    return { success: true, msg: `Saved successfully to ${filepath}` }
  } catch (err: any) {
    return { success: false, msg: `Export failed: ${err.message}` }
  }
})

function getMapsPaths() {
  const baseDir = app.getAppPath()
  const exeDir = path.dirname(app.getPath('exe'))

  const candidates = [
    path.join(baseDir, '../data/maps'),               // Dev mode root
    path.join(exeDir, '../../data/maps'),             // Packaged in dist-build/win-unpacked
    path.join(exeDir, 'data/maps'),                   // Packaged sibling to EXE
    path.join(process.resourcesPath, 'data/maps')     // Standard resources path
  ]

  for (const c of candidates) {
    const dbPath = path.join(c, 'esri_ocean_1_12.mbtiles')
    const scriptPath = path.join(c, 'get_tile.py')
    if (fs.existsSync(dbPath) && fs.existsSync(scriptPath)) {
      return { dbPath, scriptPath }
    }
  }
  return null
}

ipcMain.handle('get-tile', async (_event, { z, x, y }) => {
  return new Promise((resolve) => {
    const paths = getMapsPaths()
    if (!paths) {
      logMessage(`[MapTiles] Error: Map assets (mbtiles / script) not found in candidates list.`)
      return resolve(null)
    }

    const { dbPath, scriptPath } = paths
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

    const child = child_process.spawn(pythonCmd, [scriptPath, dbPath, z.toString(), x.toString(), y.toString()], {
      windowsHide: true
    })

    let stdoutBase64 = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdoutBase64 += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (code === 0 && stdoutBase64) {
        resolve(stdoutBase64)
      } else {
        if (stderr) {
          logMessage(`[MapTiles] Python Error: ${stderr.trim()}`)
        } else if (code !== 0) {
          logMessage(`[MapTiles] Python exited with code ${code}`)
        }
        resolve(null)
      }
    })
  })
})

// ============================================================================
// --- TAB 6: SIMULATED CUTTER CAMERA (SAMPLING CAMERA) SERVER & RENDERER ---
// ============================================================================

let cameraServer: http.Server | null = null
let cameraOffscreenWindow: BrowserWindow | null = null
let cameraFrameBuffer: Buffer = Buffer.alloc(0)
let cameraLogs: string[] = []
let cameraInterval: NodeJS.Timeout | null = null

const cameraState = {
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
  temperature: 34.5,
  port: 8888,
  host: '127.0.0.1'
}

// Load Cowcod reference photo as base64 on boot for offscreen injection
let cowcodBase64 = ''
try {
  const possiblePaths = [
    path.join(app.getAppPath(), 'public/cowcod_reference.jpeg'),
    path.join(app.getAppPath(), 'dist/cowcod_reference.jpeg'),
    path.join(__dirname, '../../public/cowcod_reference.jpeg'),
    path.join(__dirname, '../public/cowcod_reference.jpeg'),
    path.join(path.dirname(app.getPath('exe')), 'resources/app.asar/public/cowcod_reference.jpeg'),
    path.join(path.dirname(app.getPath('exe')), 'cowcod_reference.jpeg')
  ]

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      cowcodBase64 = fs.readFileSync(p).toString('base64')
      break
    }
  }
} catch (err) {
  console.error("Failed loading cowcod base64 image asset:", err)
}

const capturedImagesDir = path.join(app.getPath('userData'), 'captured_images')
if (!fs.existsSync(capturedImagesDir)) {
  fs.mkdirSync(capturedImagesDir, { recursive: true })
}

function logCameraMessage(msg: string) {
  const timestamp = new Date().toLocaleTimeString()
  const logStr = `[${timestamp}] ${msg}`
  cameraLogs.push(logStr)
  if (cameraLogs.length > 300) {
    cameraLogs.shift()
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('camera-log', logStr)
  }
}

function updateCameraOffscreenContent() {
  if (!cameraOffscreenWindow) return

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body, html {
          margin: 0; padding: 0; width: 100%; height: 100%;
          overflow: hidden; background: #000;
          font-family: Arial, sans-serif;
        }
        .container {
          position: relative; width: 1280px; height: 720px;
        }
        .bg-img {
          width: 100%; height: 100%; object-fit: cover;
        }
        .flip-v { transform: scaleY(-1); }
        .flip-h { transform: scaleX(-1); }
        .flip-vh { transform: scale(-1, -1); }
        
        /* Overlay HUD */
        .hud-overlay {
          position: absolute;
          top: 25px;
          left: 25px;
          background: rgba(4, 15, 23, 0.85);
          color: #10b981; /* emerald-500 */
          border: 1.5px solid #047857;
          border-radius: 6px;
          padding: 12px 16px;
          font-family: 'Courier New', monospace;
          font-size: 16px;
          font-weight: bold;
          line-height: 1.4;
          box-shadow: 0 4px 6px rgba(0,0,0,0.4);
        }
        .hud-item {
          display: flex;
          justify-content: space-between;
          gap: 20px;
        }
        .hud-val {
          color: #ffffff;
        }
        
        .watermark {
          position: absolute;
          bottom: 25px;
          right: 25px;
          background: rgba(0,0,0,0.6);
          color: #94a3b8;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-family: monospace;
          letter-spacing: 1px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <img class="bg-img" id="camera-bg-img" src="data:image/jpeg;base64,${cowcodBase64}" />
        
        <div class="hud-overlay">
          <div class="hud-item"><span>SPECIES:</span> <span class="hud-val" id="species-val"></span></div>
          <div class="hud-item"><span>ANGLER:</span> <span class="hud-val" id="angler-val"></span></div>
          <div class="hud-item"><span>DROP NUM:</span> <span class="hud-val" id="drop-val"></span></div>
          <div class="hud-item"><span>HOOK NUM:</span> <span class="hud-val" id="hook-val"></span></div>
          <div class="hud-item"><span>SITE NUM:</span> <span class="hud-val" id="site-val"></span></div>
          <div style="border-top: 1.5px solid #047857; margin-top: 6px; padding-top: 6px;" class="hud-item">
            <span>TEMP:</span> <span class="hud-val" id="temp-val"></span>
          </div>
          <div class="hud-item"><span>TIME:</span> <span class="hud-val" id="time-val"></span></div>
        </div>
        
        <div class="watermark">
          SIMULATED RPI OVERHEAD CAM (IMX519)
        </div>
      </div>
      
      <script>
        function updateTime() {
          const timeVal = document.getElementById('time-val');
          if (timeVal) {
            const now = new Date();
            timeVal.textContent = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
          }
        }
        setInterval(updateTime, 100);
        updateTime();

        window.updateState = (state) => {
          document.getElementById('species-val').textContent = state.species;
          document.getElementById('angler-val').textContent = state.angler_position;
          document.getElementById('drop-val').textContent = state.drop_number;
          document.getElementById('hook-val').textContent = state.hook_number;
          document.getElementById('site-val').textContent = state.site_number;
          document.getElementById('temp-val').textContent = state.temperature.toFixed(1) + '°C';
          
          const img = document.getElementById('camera-bg-img');
          if (img) {
            let cls = 'bg-img';
            if (state.vflip && state.hflip) cls += ' flip-vh';
            else if (state.vflip) cls += ' flip-v';
            else if (state.hflip) cls += ' flip-h';
            img.className = cls;
          }
        };
      </script>
    </body>
    </html>
  `
  cameraOffscreenWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function updateCameraOffscreenState() {
  if (cameraOffscreenWindow && !cameraOffscreenWindow.isDestroyed()) {
    const stateStr = JSON.stringify(cameraState)
    cameraOffscreenWindow.webContents.executeJavaScript(`
      if (typeof window.updateState === 'function') {
        window.updateState(${stateStr});
      }
    `).catch(() => {})
  }
}

function startCameraOffscreen() {
  if (cameraOffscreenWindow) return

  cameraOffscreenWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  cameraOffscreenWindow.webContents.once('did-finish-load', () => {
    updateCameraOffscreenState()
  })

  updateCameraOffscreenContent()

  // Frame grab loop at 10 FPS
  cameraInterval = setInterval(() => {
    if (!cameraOffscreenWindow || !cameraState.is_recording) return
    cameraOffscreenWindow.webContents.capturePage().then((image) => {
      cameraFrameBuffer = image.toJPEG(80)
    }).catch(() => {})
  }, 100)
}

function stopCameraOffscreen() {
  if (cameraInterval) {
    clearInterval(cameraInterval)
    cameraInterval = null
  }
  if (cameraOffscreenWindow) {
    cameraOffscreenWindow.destroy()
    cameraOffscreenWindow = null
  }
  cameraFrameBuffer = Buffer.alloc(0)
}

function zipFiles(filesList: string[], res: http.ServerResponse) {
  const pythonCode = `
import os, zipfile, sys
files = sys.argv[1].split(',')
sys.stdout.buffer.write(b'')
with zipfile.ZipFile(sys.stdout.buffer, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for f in files:
        if os.path.exists(f):
            zipf.write(f, os.path.basename(f))
  `

  const child = child_process.spawn('python', ['-c', pythonCode, filesList.join(',')], {
    windowsHide: true
  })

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename=cuttercam_images.zip'
  })

  child.stdout.pipe(res)
}

function parseJSONBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

// --- IPC Interface for simulated Camera tab ---
ipcMain.handle('get-camera-status', () => {
  return {
    active: cameraServer !== null,
    port: cameraState.port,
    host: cameraState.host,
    logs: cameraLogs,
    state: cameraState
  }
})

ipcMain.handle('start-camera-server', (_event, { host, port }) => {
  if (cameraServer) {
    return { success: true, msg: "Cutter Camera Server already running." }
  }

  cameraState.host = host || '127.0.0.1'
  cameraState.port = port || 8888

  try {
    startCameraOffscreen()

    cameraServer = http.createServer(async (req, res) => {
      // Enable CORS for frontend clients
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      const parsedUrl = new URL(req.url || '', `http://${req.headers.host}`)
      const pathname = parsedUrl.pathname

      // ROUTE: Get live MJPEG stream
      if (pathname === '/cutter-cam/video' && req.method === 'GET') {
        logCameraMessage(`GET /cutter-cam/video - Start MJPEG stream`)
        res.writeHead(200, {
          'Age': '0',
          'Cache-Control': 'no-cache, private',
          'Pragma': 'no-cache',
          'Content-Type': 'multipart/x-mixed-replace; boundary=FRAME'
        })

        const boundary = '\r\n--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: '
        const streamInterval = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(streamInterval)
            return
          }
          const frame = cameraFrameBuffer
          if (frame && frame.length > 0) {
            try {
              res.write(boundary + frame.length + '\r\n\r\n')
              res.write(frame)
              res.write('\r\n')
            } catch {
              clearInterval(streamInterval)
            }
          }
        }, 100)

        req.on('close', () => {
          clearInterval(streamInterval)
          logCameraMessage(`Closed MJPEG stream`)
        })
        return
      }

      // ROUTE: Check availability
      if (pathname === '/cutter-cam/is-api-available' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isApiAvailable: true }))
        return
      }

      // ROUTE: Check recording state
      if (pathname === '/cutter-cam/is-video-recording' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isVideoRecording: cameraState.is_recording }))
        return
      }

      // ROUTE: Temperature
      if (pathname === '/cutter-cam/temperature' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ camera_processor_temperature_c: cameraState.temperature }))
        return
      }

      // ROUTE: Config / State
      if (pathname === '/cutter-cam/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          rgbQualityOptions: ['low', 'medium', 'high', 'ultra'],
          segmentationModeOptions: ['off', 'on'],
          rgbResolutionOptions: ['640x480', '1280x720', '1920x1080'],
          cameraModel: 'IMX519 Simulated',
          isStereo: false,
          autofocus: true,
          resolution: cameraState.video_resolution,
          quality: cameraState.video_quality
        }))
        return
      }

      if (pathname === '/cutter-cam/state' && req.method === 'GET') {
        const count = fs.readdirSync(capturedImagesDir).filter(f => f.toLowerCase().endsWith('.jpeg') || f.toLowerCase().endsWith('.jpg')).length
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          currentImageCount: count,
          isVideoRecording: cameraState.is_recording,
          isApiAvailable: true,
          currentRgbResolutionName: cameraState.video_resolution,
          currentRgbQualityName: cameraState.video_quality,
          cameraProcessorTemperatureC: cameraState.temperature,
          availableDiskSpaceGb: 45.2,
          segmentationMode: 'off',
          isCameraReloadRequired: false,
          isCameraReloading: false,
          
          // Legacy snake_case fields for frontend UI config mapping
          current_species: cameraState.species,
          current_angler_position: cameraState.angler_position,
          current_drop_number: cameraState.drop_number,
          current_hook_number: cameraState.hook_number,
          current_site_number: cameraState.site_number
        }))
        return
      }

      // ROUTE: Set Species
      if (pathname === '/cutter-cam/set-species' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        cameraState.species = (payload.species || 'UNKNOWN').toUpperCase()
        logCameraMessage(`POST /cutter-cam/set-species -> "${cameraState.species}"`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isSpeciesSet: true, species: cameraState.species }))
        return
      }

      // ROUTE: Set Angler Position
      if (pathname === '/cutter-cam/set-angler-position' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        cameraState.angler_position = (payload.angler_position || '1').toString()
        logCameraMessage(`POST /cutter-cam/set-angler-position -> "${cameraState.angler_position}"`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isAnglerPositionSet: true, angler_position: cameraState.angler_position }))
        return
      }

      // ROUTE: Set Drop Number
      if (pathname === '/cutter-cam/set-drop-number' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        cameraState.drop_number = (payload.drop_number || '1').toString()
        logCameraMessage(`POST /cutter-cam/set-drop-number -> "${cameraState.drop_number}"`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isDropNumberSet: true, drop_number: cameraState.drop_number }))
        return
      }

      // ROUTE: Set Hook Number
      if (pathname === '/cutter-cam/set-hook-number' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        cameraState.hook_number = (payload.hook_number || '1').toString()
        logCameraMessage(`POST /cutter-cam/set-hook-number -> "${cameraState.hook_number}"`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isHookNumberSet: true, hook_number: cameraState.hook_number }))
        return
      }

      // ROUTE: Set Site Number
      if (pathname === '/cutter-cam/set-site-number' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        cameraState.site_number = (payload.site_number || '1').toString()
        logCameraMessage(`POST /cutter-cam/set-site-number -> "${cameraState.site_number}"`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ isSiteNumberSet: true, site_number: cameraState.site_number }))
        return
      }

      // ROUTE: Camera stream triggers
      if (pathname === '/cutter-cam/start-video' && req.method === 'POST') {
        cameraState.is_recording = true
        logCameraMessage(`POST /cutter-cam/start-video - Started stream`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }

      if (pathname === '/cutter-cam/stop-video' && req.method === 'POST') {
        cameraState.is_recording = false
        logCameraMessage(`POST /cutter-cam/stop-video - Paused stream`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }

      // ROUTE: Flip vertical/horizontal
      if (pathname === '/cutter-cam/flip-vertical' && req.method === 'POST') {
        cameraState.vflip = !cameraState.vflip
        logCameraMessage(`POST /cutter-cam/flip-vertical -> vflip=${cameraState.vflip}`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }

      if (pathname === '/cutter-cam/flip-horizontal' && req.method === 'POST') {
        cameraState.hflip = !cameraState.hflip
        logCameraMessage(`POST /cutter-cam/flip-horizontal -> hflip=${cameraState.hflip}`)
        updateCameraOffscreenState()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }

      // ROUTE: Capture Still Frame
      if (pathname === '/cutter-cam/capture' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        const filename = payload.file_name || `capture_${Date.now()}.jpeg`
        const filepath = path.join(capturedImagesDir, filename)

        logCameraMessage(`POST /cutter-cam/capture -> saving as "${filename}"`)
        if (cameraFrameBuffer && cameraFrameBuffer.length > 0) {
          try {
            fs.writeFileSync(filepath, cameraFrameBuffer)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              file_captured: true,
              file_name: filename,
              file_path: filepath
            }))
            return
          } catch (err: any) {
            logCameraMessage(`Capture Error: ${err.message}`)
          }
        }
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: "Failed to write frame buffer." }))
        return
      }

      // ROUTE: Image Count
      if (pathname === '/cutter-cam/image-count' && req.method === 'GET') {
        const count = fs.readdirSync(capturedImagesDir).filter(f => f.toLowerCase().endsWith('.jpeg') || f.toLowerCase().endsWith('.jpg')).length
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ current_image_count: count }))
        return
      }

      // ROUTE: Clear image files
      if (pathname === '/cutter-cam/clear-image-files' && req.method === 'POST') {
        const payload = await parseJSONBody(req)
        if (payload.secret_key === 'D3l3t3ME!') {
          const files = fs.readdirSync(capturedImagesDir)
          for (const f of files) {
            try {
              fs.unlinkSync(path.join(capturedImagesDir, f))
            } catch {}
          }
          logCameraMessage(`POST /cutter-cam/clear-image-files - Cleared all captured images`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
          return
        }
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, detail: "Invalid secret key." }))
        return
      }

      // ROUTE: Download Images as ZIP
      if (pathname === '/cutter-cam/download-images' && req.method === 'GET') {
        const lastTimestampStr = parsedUrl.searchParams.get('last_timestamp_str')
        logCameraMessage(`GET /cutter-cam/download-images - last_timestamp_str=${lastTimestampStr}`)

        let files = fs.readdirSync(capturedImagesDir)
          .filter(f => f.toLowerCase().endsWith('.jpeg') || f.toLowerCase().endsWith('.jpg'))

        if (lastTimestampStr) {
          files = files.filter(f => {
            const match = f.match(/_HD_(\d{8}T\d{6})/i)
            if (match) {
              const fileTimestamp = match[1]
              return fileTimestamp > lastTimestampStr
            }
            return true // return if no timestamp parsed to be safe
          })
        }

        const absolutePaths = files.map(f => path.join(capturedImagesDir, f))
        zipFiles(absolutePaths, res)
        return
      }

      // ROUTE: Download single image inside a ZIP
      if (pathname === '/cutter-cam/download-image' && req.method === 'GET') {
        const imageName = parsedUrl.searchParams.get('image_name')
        logCameraMessage(`GET /cutter-cam/download-image - requested image_name=${imageName}`)

        if (imageName && fs.existsSync(path.join(capturedImagesDir, imageName))) {
          zipFiles([path.join(capturedImagesDir, imageName)], res)
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: "Image not found." }))
        }
        return
      }

      // ROUTE: Download today's images inside a ZIP
      if (pathname === '/cutter-cam/download-todays-images' && req.method === 'GET') {
        logCameraMessage(`GET /cutter-cam/download-todays-images`)
        const lastNight = new Date().setHours(0, 0, 1, 0)

        const files = fs.readdirSync(capturedImagesDir)
          .filter(f => {
            const p = path.join(capturedImagesDir, f)
            const stat = fs.statSync(p)
            return stat.ctimeMs > lastNight
          })
          .map(f => path.join(capturedImagesDir, f))

        zipFiles(files, res)
        return
      }

      // ROUTE: Retrieve journals logs list
      if (pathname === '/cutter-cam/logs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(cameraLogs))
        return
      }

      // Default route
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: "Endpoint not found." }))
    })

    cameraServer.listen(cameraState.port, cameraState.host, () => {
      logCameraMessage(`Cutter Camera Simulator REST/MJPEG Server listening on http://${cameraState.host}:${cameraState.port}`)
    })

    // Random temperature fluctuate simulation loop
    const tempInterval = setInterval(() => {
      if (!cameraServer) {
        clearInterval(tempInterval)
        return
      }
      cameraState.temperature = 34.0 + Math.random() * 1.5
      updateCameraOffscreenState()
    }, 5000)

    return { success: true, msg: `Simulated Camera running on http://${cameraState.host}:${cameraState.port}` }
  } catch (err: any) {
    stopCameraOffscreen()
    cameraServer = null
    return { success: false, msg: `Failed to start Camera Server: ${err.message}` }
  }
})

ipcMain.handle('stop-camera-server', () => {
  if (cameraServer) {
    cameraServer.close()
    cameraServer = null
  }
  stopCameraOffscreen()
  logCameraMessage(`Cutter Camera Server stopped.`)
  return true
})
