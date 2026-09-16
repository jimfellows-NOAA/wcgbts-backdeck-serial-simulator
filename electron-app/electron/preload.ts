import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // General Log
  onLog: (callback: (msg: string) => void) => {
    const listener = (_event: any, msg: string) => callback(msg)
    ipcRenderer.on('log', listener)
    return () => ipcRenderer.removeListener('log', listener)
  },
  getAvailablePorts: () => ipcRenderer.invoke('get-available-ports'),

  // Config Persistence
  saveConfig: (key: string, value: any) => ipcRenderer.send('save-config', { key, value }),
  loadConfig: () => ipcRenderer.invoke('load-config'),

  // Tab 1: Simulated Devices & Printers
  sendDeviceData: (device: string, value: string, port: string, baud: number) => 
    ipcRenderer.send('send-device-data', { device, value, port, baud }),
  
  togglePrinterListener: (printer: string, port: string, baud: number, active: boolean) =>
    ipcRenderer.send('toggle-printer-listener', { printer, port, baud, active }),
  
  onPrinterLabel: (callback: (data: { printer: string, label: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('printer-label', listener)
    return () => ipcRenderer.removeListener('printer-label', listener)
  },

  // Tab 2: Telemetry Forwarding
  testConnection: (ip: string) => ipcRenderer.send('test-connection', ip),
  onConnectionTestResult: (callback: (data: { success: boolean, msg: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('connection-test-result', listener)
    return () => ipcRenderer.removeListener('connection-test-result', listener)
  },

  toggleTelemetryCOM: (mappingId: number, tcpPort: number, comPort: string, baudRate: number, active: boolean) =>
    ipcRenderer.send('toggle-telemetry-com', { mappingId, tcpPort, comPort, baudRate, active }),
  
  toggleTelemetryUDP: (mappingId: number, tcpPort: number, udpIp: string, udpPort: number, active: boolean) =>
    ipcRenderer.send('toggle-telemetry-udp', { mappingId, tcpPort, udpIp, udpPort, active }),

  onTelemetryStatus: (callback: (data: { type: 'com' | 'udp', id: number, status: 'green' | 'yellow' | 'grey' | 'red' }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('telemetry-status', listener)
    return () => ipcRenderer.removeListener('telemetry-status', listener)
  },

  onTelemetryStreamLog: (callback: (data: { type: 'com' | 'udp', text: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data)
    ipcRenderer.on('telemetry-stream-log', listener)
    return () => ipcRenderer.removeListener('telemetry-stream-log', listener)
  },

  // Tab 3: Vessel Simulator
  startVesselSim: () => ipcRenderer.send('start-vessel-sim'),
  stopVesselSim: () => ipcRenderer.send('stop-vessel-sim'),
  updateVesselSpeed: (speed: number) => ipcRenderer.send('update-vessel-speed', speed),
  toggleVesselBreadcrumbs: (enabled: boolean) => ipcRenderer.send('toggle-vessel-breadcrumbs', enabled),
  
  addVesselPort: (device: string, port: number, protocol: string, hz: number, baud: number) =>
    ipcRenderer.invoke('add-vessel-port', { device, port, protocol, hz, baud }),
  
  removeVesselPort: (port: number) =>
    ipcRenderer.invoke('remove-vessel-port', port),

  onVesselState: (callback: (state: any) => void) => {
    const listener = (_event: any, state: any) => callback(state)
    ipcRenderer.on('vessel-state', listener)
    return () => ipcRenderer.removeListener('vessel-state', listener)
  },

  onVesselNmea: (callback: (nmea: string) => void) => {
    const listener = (_event: any, nmea: string) => callback(nmea)
    ipcRenderer.on('vessel-nmea', listener)
    return () => ipcRenderer.removeListener('vessel-nmea', listener)
  }
})
