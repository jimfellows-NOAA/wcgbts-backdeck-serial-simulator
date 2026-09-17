export interface BroadcastPort {
  id: string;
  device: string;
  protocol: 'SERIAL' | 'UDP' | 'TCP';
  hz: number;
  comPort?: string;
  baud?: number;
  host?: string;
  netPort?: number;
  sentences: string[];
}

export interface IElectronAPI {
  onLog: (callback: (msg: string) => void) => () => void;
  getAvailablePorts: () => Promise<string[]>;
  saveConfig: (key: string, value: any) => void;
  loadConfig: () => Promise<Record<string, any>>;

  sendDeviceData: (device: string, value: string, port: string, baud: number) => void;
  togglePrinterListener: (printer: string, port: string, baud: number, active: boolean) => void;
  onPrinterLabel: (callback: (data: { printer: string, label: string }) => void) => () => void;

  testConnection: (ip: string) => void;
  onConnectionTestResult: (callback: (data: { success: boolean, msg: string }) => void) => () => void;

  toggleTelemetryCOM: (mappingId: number, tcpPort: number, comPort: string, baudRate: number, active: boolean) => void;
  toggleTelemetryUDP: (mappingId: number, tcpPort: number, udpIp: string, udpPort: number, active: boolean) => void;
  onTelemetryStatus: (callback: (data: { type: 'com' | 'udp', id: number, status: 'green' | 'yellow' | 'grey' | 'red' }) => void) => () => void;
  onTelemetryStreamLog: (callback: (data: { type: 'com' | 'udp', text: string }) => void) => () => void;

  startVesselSim: () => void;
  stopVesselSim: () => void;
  updateVesselSpeed: (speed: number) => void;
  updateWindSpeed: (speed: number) => void;
  updateWindDir: (dir: number) => void;
  updateDepthSet: (depth: number) => void;
  updateTempSet: (temp: number) => void;
  steerLeft: () => void;
  steerRight: () => void;
  updateVesselCoords: (lat: number, lon: number) => void;
  toggleVesselBreadcrumbs: (enabled: boolean) => void;
  addVesselPort: (portConfig: BroadcastPort) => Promise<{ success: boolean, msg: string }>;
  removeVesselPort: (id: string) => Promise<boolean>;
  onVesselState: (callback: (state: any) => void) => () => void;
  onVesselNmea: (callback: (nmea: string) => void) => () => void;
  getTile: (z: number, x: number, y: number) => Promise<string | null>;

  runPing: (targetIp: string) => Promise<{ success: boolean, output: string }>;
  mapDrive: (driveLetter: string, targetIp: string) => Promise<{ success: boolean, output: string }>;
  runDriveSpeedTest: (path: string, sizeMb: number) => Promise<{ success: boolean, speedMbSec: number, duration: number, msg: string }>;
  exportDiagLogs: (summary: string, details: string) => Promise<{ success: boolean, msg: string }>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}
