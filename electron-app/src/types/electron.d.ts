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
  toggleVesselBreadcrumbs: (enabled: boolean) => void;
  addVesselPort: (device: string, port: number, protocol: string, hz: number, baud: number) => Promise<{ success: boolean, msg: string }>;
  removeVesselPort: (port: number) => Promise<boolean>;
  onVesselState: (callback: (state: any) => void) => () => void;
  onVesselNmea: (callback: (nmea: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}
