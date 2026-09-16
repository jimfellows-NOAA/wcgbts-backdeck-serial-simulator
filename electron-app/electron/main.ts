import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import dgram from 'node:dgram'
import dns from 'node:dns'

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
  "Echosounder_Depth_Temp": ["$SDDBS", "$SDDBT", "$SDDPT", "$SDMTW"],
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

const state = {
  vessel: {
    lat: 38.035,
    lon: -123.394,
    sog_knots: 0.0,
    heading: 0.0,
    track: 0.0,
    seafloor_depth: 0.0,
    pitch: 0.0,
    roll: 0.0,
    heave: 0.0,
    area_swept_kpi: 0.0,
    default_speed: 10.0,
    breadcrumb_enabled: true
  },
  track_history: [] as Array<[number, number, number]>,
  latest_sentences: {} as Record<string, string>,
  active_ports: {} as Record<string, { port: number, protocol: string, hz: number, baud: number }>,
  current_mode: 'Idle',
  clear_history() {
    this.track_history = []
  }
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
    width: 850,
    height: 850,
    icon: path.join(__dirname, '../serial_port.ico'),
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
  for (const port of Object.keys(serverInstances).map(Number)) {
    stopVesselPortLogic(port)
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
    const val = Math.random() * 6.5 + 2.0
    return `@IIMTW,${val.toFixed(1)},C\r\n`
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
    const val = Math.random() * 6 + 9.0
    const body = `SDMTW,${val.toFixed(1)},C`
    return `$${body}*${generateChecksum(body)}\r\n`
  },
  '$WIMWV': () => {
    const t_dir = Math.random() * 360
    const t_spd = Math.random() * 20 + 5
    const r_ang = (t_dir - state.vessel.track + Math.random() * 60 - 30) % 360
    const r_spd = Math.abs(t_spd + Math.random() * 4 - 2)
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
})

ipcMain.on('toggle-vessel-breadcrumbs', (_event, enabled) => {
  state.vessel.breadcrumb_enabled = enabled
})

ipcMain.on('start-vessel-sim', () => {
  if (simInterval) {
    return
  }

  state.clear_history()
  state.current_mode = 'Simulation'
  logMessage('[VesselSim] 10Hz native simulation engine started.')

  let track = Math.random() * 360
  let loopCounter = 0

  simInterval = setInterval(() => {
    // Kinematics updates
    const speedKts = state.vessel.default_speed * (Math.random() * 0.2 + 0.9)
    const metersPerSec = speedKts * 0.514444
    if (speedKts > 0) {
      track = (track + (Math.random() * 2 - 1)) % 360
    }

    const [nLat, nLon] = calculate_destination(state.vessel.lat, state.vessel.lon, track, metersPerSec * 0.1)
    const depth = Math.floor(Math.random() * 270 + 180)

    state.vessel.lat = nLat
    state.vessel.lon = nLon
    state.vessel.sog_knots = speedKts
    state.vessel.track = track
    state.vessel.heading = track
    state.vessel.seafloor_depth = depth
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

    // Pipe 10Hz NMEA live log to Renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vessel-nmea', list.join(''))
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
          breadcrumbEnabled: state.vessel.breadcrumb_enabled
        })
      }
    }

    // Stream out data to active ports
    for (const [devName, info] of Object.entries(state.active_ports)) {
      const headers = DEVICE_GROUPS[devName] || []
      const outSentences: string[] = []
      for (const h of headers) {
        const payload = state.latest_sentences[h]
        if (payload) {
          outSentences.push(payload)
        }
      }
      const dataPayload = outSentences.join('')
      if (dataPayload) {
        // Broadcast over TCP or UDP
        if (info.protocol === 'UDP') {
          const udpSocket = dgram.createSocket('udp4')
          udpSocket.send(Buffer.from(dataPayload, 'ascii'), info.port, '255.255.255.255', () => {
            udpSocket.close()
          })
        }
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
      breadcrumbEnabled: state.vessel.breadcrumb_enabled
    })
  }
})

// --- VESSEL BROADCAST PORTS HANDLERS ---
ipcMain.handle('add-vessel-port', (_event, { device, port, protocol, hz, baud }) => {
  if (serverInstances[port]) {
    return { success: false, msg: 'Port already active.' }
  }

  stopFlags[port] = false

  if (protocol === 'UDP') {
    // UDP Broadcaster handles broadcasting natively during the sim interval.
    state.active_ports[device] = { port, protocol, hz, baud }
    serverInstances[port] = { type: 'UDP' }
    logMessage(`[VesselSim] Active broadcast: ${device} on Port ${port} (${protocol})`)
    return { success: true, msg: `Configured UDP Broadcast on ${port}` }
  } else {
    // TCP or simulated Serial server
    const server = net.createServer((socket) => {
      const interval = setInterval(() => {
        if (stopFlags[port]) {
          clearInterval(interval)
          socket.destroy()
          return
        }

        const outSentences: string[] = []
        const headers = DEVICE_GROUPS[device] || []
        for (const h of headers) {
          const s = state.latest_sentences[h]
          if (s) {
            outSentences.push(s)
          }
        }
        const dataPayload = outSentences.join('')
        if (dataPayload) {
          socket.write(dataPayload, 'ascii')
        }
      }, Math.floor(1000 / hz))

      socket.on('error', () => {
        clearInterval(interval)
      })

      socket.on('close', () => {
        clearInterval(interval)
      })
    })

    server.listen(port, '127.0.0.1')
    serverInstances[port] = server
    state.active_ports[device] = { port, protocol, hz, baud }
    logMessage(`[VesselSim] Active broadcast: ${device} on Port ${port} (${protocol})`)
    return { success: true, msg: `TCP Server listening on Port ${port}` }
  }
})

ipcMain.handle('remove-vessel-port', (_event, port) => {
  stopVesselPortLogic(port)
  return true
})

function stopVesselPortLogic(port: number) {
  stopFlags[port] = true
  const instance = serverInstances[port]
  if (instance) {
    if (instance.type !== 'UDP' && typeof instance.close === 'function') {
      instance.close()
    }
    delete serverInstances[port]
    delete stopFlags[port]
  }

  const dev = Object.keys(state.active_ports).find(k => state.active_ports[k].port === port)
  if (dev) {
    delete state.active_ports[dev]
  }
  logMessage(`[VesselSim] Removed broadcast on Port ${port}`)
}
