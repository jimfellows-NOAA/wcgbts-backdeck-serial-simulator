import React, { useState, useEffect, useRef } from 'react'
import { Server, Plus, Trash2 } from 'lucide-react'

interface COMBridge {
  id: number
  tcpPort: number
  comPort: string
  baudRate: number
  active: boolean
  status: 'green' | 'yellow' | 'grey' | 'red'
}

interface UDPBridge {
  id: number
  tcpPort: number
  udpIp: string
  udpPort: number
  active: boolean
  status: 'green' | 'yellow' | 'grey' | 'red'
}

export default function TelemetryTab() {
  const [comPorts, setComPorts] = useState<string[]>([])
  const [serverIp, setServerIp] = useState('161.55.52.50')
  const [testingConnection, setTestingConnection] = useState(false)

  // Bridges mappings state
  const [comBridges, setComBridges] = useState<COMBridge[]>([])
  const [udpBridges, setUdpBridges] = useState<UDPBridge[]>([])

  // UI inputs state
  const [newTCPPortCOM, setNewTCPPortCOM] = useState('')
  const [newCOMPort, setNewCOMPort] = useState('COM220')
  const [newBaudCOM, setNewBaudCOM] = useState('9600')

  const [newTCPPortUDP, setNewTCPPortUDP] = useState('')
  const [newUDPIp, setNewUDPIp] = useState('127.0.0.1')
  const [newUDPPort, setNewUDPPort] = useState('10110')

  // Stream console logs state
  const [comLogs, setComLogs] = useState<string[]>([])
  const [udpLogs, setUdpLogs] = useState<string[]>([])

  const comLogRef = useRef<HTMLDivElement>(null)
  const udpLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Load config and COM list
    window.electronAPI.getAvailablePorts().then((ports) => setComPorts(ports))
    window.electronAPI.loadConfig().then((config) => {
      if (config.server_ip) setServerIp(config.server_ip)
      if (config.com_bridges) setComBridges(config.com_bridges)
      if (config.udp_bridges) setUdpBridges(config.udp_bridges)
    })

    // Listeners for IP test
    const unsubscribeTestResult = window.electronAPI.onConnectionTestResult(({ success, msg }) => {
      setTestingConnection(false)
      alert(msg)
    })

    // Listeners for status light updates
    const unsubscribeStatus = window.electronAPI.onTelemetryStatus(({ type, id, status }) => {
      if (type === 'com') {
        setComBridges((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b)))
      } else {
        setUdpBridges((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b)))
      }
    })

    // Listeners for streams logging
    const unsubscribeStreamLog = window.electronAPI.onTelemetryStreamLog(({ type, text }) => {
      if (type === 'com') {
        setComLogs((prev) => [...prev, text].slice(-200))
      } else {
        setUdpLogs((prev) => [...prev, text].slice(-200))
      }
    })

    return () => {
      unsubscribeTestResult()
      unsubscribeStatus()
      unsubscribeStreamLog()
    }
  }, [])

  useEffect(() => {
    if (comLogRef.current) comLogRef.current.scrollTop = comLogRef.current.scrollHeight
  }, [comLogs])

  useEffect(() => {
    if (udpLogRef.current) udpLogRef.current.scrollTop = udpLogRef.current.scrollHeight
  }, [udpLogs])

  const saveIp = () => {
    window.electronAPI.saveConfig('server_ip', serverIp)
    alert('Server IP Address saved successfully!')
  }

  const testConnection = () => {
    setTestingConnection(true)
    window.electronAPI.testConnection(serverIp)
  }

  const persistBridges = (updatedCOM: COMBridge[], updatedUDP: UDPBridge[]) => {
    window.electronAPI.saveConfig('com_bridges', updatedCOM)
    window.electronAPI.saveConfig('udp_bridges', updatedUDP)
  }

  // Add COM Mapping
  const addCOMMapping = () => {
    const tcp = parseInt(newTCPPortCOM)
    if (isNaN(tcp)) return alert('TCP port must be a valid integer.')
    if (!newCOMPort) return alert('Select a COM port.')

    const newBridge: COMBridge = {
      id: Date.now(),
      tcpPort: tcp,
      comPort: newCOMPort,
      baudRate: parseInt(newBaudCOM),
      active: false,
      status: 'grey',
    }

    const updated = [...comBridges, newBridge]
    setComBridges(updated)
    persistBridges(updated, udpBridges)
    setNewTCPPortCOM('')
  }

  // Add UDP Mapping
  const addUDPMapping = () => {
    const tcp = parseInt(newTCPPortUDP)
    const udp = parseInt(newUDPPort)
    if (isNaN(tcp) || isNaN(udp)) return alert('Ports must be valid integers.')
    if (!newUDPIp) return alert('Target IP cannot be empty.')

    const newBridge: UDPBridge = {
      id: Date.now(),
      tcpPort: tcp,
      udpIp: newUDPIp,
      udpPort: udp,
      active: false,
      status: 'grey',
    }

    const updated = [...udpBridges, newBridge]
    setUdpBridges(updated)
    persistBridges(comBridges, updated)
    setNewTCPPortUDP('')
  }

  const deleteCOMBridge = (id: number) => {
    const updated = comBridges.filter((b) => b.id !== id)
    setComBridges(updated)
    persistBridges(updated, udpBridges)
  }

  const deleteUDPBridge = (id: number) => {
    const updated = udpBridges.filter((b) => b.id !== id)
    setUdpBridges(updated)
    persistBridges(comBridges, updated)
  }

  const toggleCOMBridge = (bridge: COMBridge) => {
    const nextActive = !bridge.active
    setComBridges((prev) =>
      prev.map((b) => (b.id === bridge.id ? { ...b, active: nextActive, status: nextActive ? 'yellow' : 'grey' } : b))
    )
    window.electronAPI.toggleTelemetryCOM(bridge.id, bridge.tcpPort, bridge.comPort, bridge.baudRate, nextActive)
  }

  const toggleUDPBridge = (bridge: UDPBridge) => {
    const nextActive = !bridge.active
    setUdpBridges((prev) =>
      prev.map((b) => (b.id === bridge.id ? { ...b, active: nextActive, status: nextActive ? 'yellow' : 'grey' } : b))
    )
    window.electronAPI.toggleTelemetryUDP(bridge.id, bridge.tcpPort, bridge.udpIp, bridge.udpPort, nextActive)
  }

  const getStatusColorClass = (status: string) => {
    switch (status) {
      case 'green':
        return 'bg-emerald-500 shadow-emerald-500/50'
      case 'yellow':
        return 'bg-amber-400 shadow-amber-500/50'
      case 'red':
        return 'bg-rose-500 shadow-rose-500/50'
      default:
        return 'bg-gray-600 shadow-gray-700/50'
    }
  }

  return (
    <div className="flex flex-col h-full gap-4 overflow-hidden">
      {/* --- SERVER CONFIG HEADER --- */}
      <div className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 rounded-lg shadow-sm">
        <Server className="w-5 h-5 text-orange-500" />
        <span className="text-sm font-semibold text-gray-300">Vessel Server Config:</span>
        <input
          type="text"
          value={serverIp}
          onChange={(e) => setServerIp(e.target.value)}
          className="bg-gray-950 border border-gray-800/80 rounded px-3 py-1 text-xs font-semibold text-gray-300 focus:outline-none focus:border-orange-500 shadow-inner w-44"
          placeholder="e.g. 161.55.52.50"
        />
        <button
          onClick={saveIp}
          className="px-3 py-1 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 border border-gray-700 rounded text-xs font-semibold text-gray-200 transition cursor-pointer"
        >
          Save Config
        </button>
        <button
          onClick={testConnection}
          disabled={testingConnection}
          className="px-3 py-1 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 border border-gray-700 rounded text-xs font-semibold text-gray-200 transition disabled:opacity-50 cursor-pointer"
        >
          {testingConnection ? 'Testing...' : 'Test Connection'}
        </button>
      </div>

      {/* --- BRIDGES SIDE-BY-SIDE PANELS --- */}
      <div className="flex-grow grid grid-cols-2 gap-4 overflow-hidden">
        {/* LEFT COLUMN: TCP TO COM BRIDGES */}
        <div className="flex flex-col border border-gray-800/60 bg-gray-900/10 rounded-lg p-4 overflow-hidden">
          <h4 className="text-xs font-bold text-gray-400 tracking-wider mb-3">
            TCP TO VIRTUAL COM BRIDGES
          </h4>

          {/* Add Form */}
          <div className="flex items-center gap-2 mb-4 bg-gray-900/60 p-2.5 rounded-lg border border-gray-800">
            <span className="text-xs text-gray-400 font-semibold">TCP:</span>
            <input
              type="text"
              value={newTCPPortCOM}
              onChange={(e) => setNewTCPPortCOM(e.target.value)}
              className="bg-gray-950 border border-gray-800 rounded px-2 py-0.5 text-xs text-orange-400 font-bold focus:outline-none w-14 shadow-inner"
              placeholder="6004"
            />

            <span className="text-xs text-gray-400 font-semibold">COM:</span>
            <select
              value={newCOMPort}
              onChange={(e) => setNewCOMPort(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-300 focus:outline-none cursor-pointer"
            >
              {comPorts.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <span className="text-xs text-gray-400 font-semibold">Baud:</span>
            <select
              value={newBaudCOM}
              onChange={(e) => setNewBaudCOM(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-300 focus:outline-none cursor-pointer"
            >
              <option value="9600">9600</option>
              <option value="38400">38400</option>
              <option value="115200">115200</option>
            </select>

            <button
              onClick={addCOMMapping}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white text-xs font-bold rounded shadow transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>

          {/* Mappings List */}
          <div className="flex-grow overflow-y-auto flex flex-col gap-2 p-1">
            {comBridges.map((bridge) => (
              <div
                key={bridge.id}
                className="flex items-center justify-between px-3 py-2 bg-gray-900 border border-gray-800/80 rounded-lg"
              >
                <span className="text-xs font-mono text-gray-300">
                  TCP:{bridge.tcpPort} → {bridge.comPort}
                </span>

                <div className="flex items-center gap-4">
                  {/* Status Indicator LED */}
                  <div
                    className={`w-3 h-3 rounded-full shadow-lg ${getStatusColorClass(
                      bridge.status
                    )}`}
                  ></div>

                  <button
                    onClick={() => toggleCOMBridge(bridge)}
                    className={`px-3 py-0.5 rounded text-xs font-bold transition-all cursor-pointer ${
                      bridge.active
                        ? 'bg-rose-500 hover:bg-rose-600 active:bg-rose-700 text-white'
                        : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                    }`}
                  >
                    {bridge.active ? 'Stop' : 'Start'}
                  </button>

                  <button
                    onClick={() => deleteCOMBridge(bridge.id)}
                    disabled={bridge.active}
                    className="text-gray-500 hover:text-rose-400 disabled:opacity-40 disabled:hover:text-gray-500 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Live COM stream console terminal */}
          <div className="h-32 border border-gray-800 bg-gray-950/60 rounded-lg p-3 mt-3 flex flex-col shrink-0">
            <div className="flex justify-between items-center mb-1 border-b border-gray-800/30 pb-1">
              <span className="text-[10px] font-bold text-gray-400 tracking-wider">
                LIVE COM STREAM MONITOR
              </span>
              <button
                onClick={() => setComLogs([])}
                className="text-[10px] text-gray-500 hover:text-gray-200"
              >
                Clear
              </button>
            </div>
            <div
              ref={comLogRef}
              className="flex-grow overflow-y-auto font-mono text-[10px] text-emerald-400/90 leading-tight whitespace-pre"
            >
              {comLogs.join('') || <span className="text-gray-600 italic">No stream active...</span>}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: TCP TO UDP BRIDGES */}
        <div className="flex flex-col border border-gray-800/60 bg-gray-900/10 rounded-lg p-4 overflow-hidden">
          <h4 className="text-xs font-bold text-gray-400 tracking-wider mb-3">
            TCP TO UDP BRIDGES (COALESCER)
          </h4>

          {/* Add Form */}
          <div className="flex items-center gap-2 mb-4 bg-gray-900/60 p-2.5 rounded-lg border border-gray-800">
            <span className="text-xs text-gray-400 font-semibold">TCP:</span>
            <input
              type="text"
              value={newTCPPortUDP}
              onChange={(e) => setNewTCPPortUDP(e.target.value)}
              className="bg-gray-950 border border-gray-800 rounded px-2 py-0.5 text-xs text-orange-400 font-bold focus:outline-none w-14 shadow-inner"
              placeholder="6004"
            />

            <span className="text-xs text-gray-400 font-semibold">IP:</span>
            <input
              type="text"
              value={newUDPIp}
              onChange={(e) => setNewUDPIp(e.target.value)}
              className="bg-gray-950 border border-gray-800 rounded px-2 py-0.5 text-xs text-gray-300 font-semibold focus:outline-none w-24 shadow-inner"
            />

            <span className="text-xs text-gray-400 font-semibold">UDP:</span>
            <input
              type="text"
              value={newUDPPort}
              onChange={(e) => setNewUDPPort(e.target.value)}
              className="bg-gray-950 border border-gray-800 rounded px-2 py-0.5 text-xs text-gray-300 font-semibold focus:outline-none w-14 shadow-inner"
            />

            <button
              onClick={addUDPMapping}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white text-xs font-bold rounded shadow transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>

          {/* Mappings List */}
          <div className="flex-grow overflow-y-auto flex flex-col gap-2 p-1">
            {udpBridges.map((bridge) => (
              <div
                key={bridge.id}
                className="flex items-center justify-between px-3 py-2 bg-gray-900 border border-gray-800/80 rounded-lg"
              >
                <span className="text-xs font-mono text-gray-300">
                  TCP:{bridge.tcpPort} → UDP {bridge.udpIp}:{bridge.udpPort}
                </span>

                <div className="flex items-center gap-4">
                  {/* Status Indicator LED */}
                  <div
                    className={`w-3 h-3 rounded-full shadow-lg ${getStatusColorClass(
                      bridge.status
                    )}`}
                  ></div>

                  <button
                    onClick={() => toggleUDPBridge(bridge)}
                    className={`px-3 py-0.5 rounded text-xs font-bold transition-all cursor-pointer ${
                      bridge.active
                        ? 'bg-rose-500 hover:bg-rose-600 active:bg-rose-700 text-white'
                        : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                    }`}
                  >
                    {bridge.active ? 'Stop' : 'Start'}
                  </button>

                  <button
                    onClick={() => deleteUDPBridge(bridge.id)}
                    disabled={bridge.active}
                    className="text-gray-500 hover:text-rose-400 disabled:opacity-40 disabled:hover:text-gray-500 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Live UDP stream console terminal */}
          <div className="h-32 border border-gray-800 bg-gray-950/60 rounded-lg p-3 mt-3 flex flex-col shrink-0">
            <div className="flex justify-between items-center mb-1 border-b border-gray-800/30 pb-1">
              <span className="text-[10px] font-bold text-gray-400 tracking-wider">
                LIVE UDP STREAM MONITOR
              </span>
              <button
                onClick={() => setUdpLogs([])}
                className="text-[10px] text-gray-500 hover:text-gray-200"
              >
                Clear
              </button>
            </div>
            <div
              ref={udpLogRef}
              className="flex-grow overflow-y-auto font-mono text-[10px] text-emerald-400/90 leading-tight whitespace-pre"
            >
              {udpLogs.join('') || <span className="text-gray-600 italic">No stream active...</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
