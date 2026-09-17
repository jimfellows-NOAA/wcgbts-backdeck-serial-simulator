import React, { useState, useEffect } from 'react'
import { Send, Volume2, HelpCircle } from 'lucide-react'

interface DeviceState {
  port: string
  baud: string
  value: string
}

export default function DevicesTab() {
  const [comPorts, setComPorts] = useState<string[]>([])
  const [devices, setDevices] = useState<Record<string, DeviceState>>({
    'Marel M1100 - Large': { port: 'COM201', baud: '9600', value: '3.42' },
    'Marel M1100 - Small': { port: 'COM202', baud: '9600', value: '1.24' },
    'Scantrol FM-100': { port: 'COM203', baud: '9600', value: '25.0' },
    'Zebra Barcode Gun': { port: 'COM204', baud: '9600', value: 'A11' },
    'IchthyStick v3': { port: 'COM205', baud: '9600', value: '34.5' },
    'Zebra Printer 1': { port: 'COM210', baud: '9600', value: '' },
    'Zebra Printer 2': { port: 'COM211', baud: '9600', value: '' },
  })

  const [printerListening, setPrinterRunning] = useState<Record<string, boolean>>({
    'Zebra Printer 1': false,
    'Zebra Printer 2': false,
  })

  const [printerLabels, setPrinterLabels] = useState<Record<string, string>>({
    'Zebra Printer 1': '=== READY FOR PRINT JOB ===',
    'Zebra Printer 2': '=== READY FOR PRINT JOB ===',
  })

  useEffect(() => {
    // Fetch available COM ports from Main Process
    window.electronAPI.getAvailablePorts().then((ports) => {
      setComPorts(ports)
    })

    // Listen to print label events
    const unsubscribeLabel = window.electronAPI.onPrinterLabel(({ printer, label }) => {
      setPrinterLabels((prev) => ({ ...prev, [printer]: label }))
    })

    return () => {
      unsubscribeLabel()
    }
  }, [])

  const handleDeviceChange = (dev: string, key: keyof DeviceState, val: string) => {
    setDevices((prev) => ({
      ...prev,
      [dev]: { ...prev[dev], [key]: val },
    }))
  }

  const handleSend = (devName: string) => {
    const dev = devices[devName]
    if (!dev.port || !dev.value) {
      alert('Specify COM port and value.')
      return
    }
    window.electronAPI.sendDeviceData(devName, dev.value, dev.port, parseInt(dev.baud))
  }

  const togglePrinter = (printerName: string) => {
    const printer = devices[printerName]
    const currentActive = printerListening[printerName]
    const nextActive = !currentActive

    setPrinterRunning((prev) => ({ ...prev, [printerName]: nextActive }))
    window.electronAPI.togglePrinterListener(printerName, printer.port, parseInt(printer.baud), nextActive)
  }

  return (
    <div className="flex flex-col h-full gap-4 overflow-y-auto">
      {/* --- DEVICES SECTION --- */}
      <div className="grid grid-cols-1 gap-3">
        {/* Table Headers */}
        <div className="flex items-center px-4 py-1 text-xs font-bold text-gray-400 tracking-wider">
          <div className="w-1/4">SIMULATED DEVICE</div>
          <div className="w-1/6">COM PORT</div>
          <div className="w-1/6">BAUD RATE</div>
          <div className="w-1/3">SIMULATED VALUE</div>
          <div className="w-1/12 text-right">ACTION</div>
        </div>

        {/* Device Rows */}
        {Object.keys(devices)
          .filter((k) => !k.includes('Printer'))
          .map((devName) => {
            const dev = devices[devName]
            return (
              <div
                key={devName}
                className="flex items-center gap-3 px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg shadow-sm hover:border-gray-700 hover:bg-gray-900/80 transition-all"
              >
                {/* Name */}
                <div className="w-1/4 font-semibold text-gray-200 text-sm">
                  {devName}
                </div>

                {/* COM Port */}
                <div className="w-1/6">
                  <select
                    value={dev.port}
                    onChange={(e) => handleDeviceChange(devName, 'port', e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700/60 rounded px-2 py-1 text-xs font-semibold text-gray-300 focus:outline-none focus:border-orange-500 cursor-pointer"
                  >
                    <option value="">-- Port --</option>
                    {comPorts.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Baud */}
                <div className="w-1/6">
                  <select
                    value={dev.baud}
                    onChange={(e) => handleDeviceChange(devName, 'baud', e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700/60 rounded px-2 py-1 text-xs font-semibold text-gray-300 focus:outline-none focus:border-orange-500 cursor-pointer"
                  >
                    <option value="4800">4800</option>
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                    <option value="38400">38400</option>
                    <option value="115200">115200</option>
                  </select>
                </div>

                {/* Value */}
                <div className="w-1/3">
                  <input
                    type="text"
                    value={dev.value}
                    onChange={(e) => handleDeviceChange(devName, 'value', e.target.value)}
                    className="w-full bg-gray-950 border border-gray-800/80 rounded px-3 py-1 text-xs font-mono font-bold text-orange-400 focus:outline-none focus:border-orange-500 shadow-inner"
                    placeholder="Enter output value"
                  />
                </div>

                {/* Action */}
                <div className="w-1/12 text-right">
                  <button
                    onClick={() => handleSend(devName)}
                    className="inline-flex items-center gap-1.5 px-3 py-1 bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white rounded text-xs font-bold shadow transition-all cursor-pointer"
                  >
                    <Send className="w-3 h-3" />
                    Send
                  </button>
                </div>
              </div>
            )
          })}
      </div>

      <div className="border-t border-gray-800/60 my-2"></div>

      {/* --- PRINTERS SECTION --- */}
      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-bold text-gray-400 tracking-wider">
          ZEBRA PRINTER RECEIVERS (LISTENERS)
        </h3>

        <div className="grid grid-cols-2 gap-4">
          {['Zebra Printer 1', 'Zebra Printer 2'].map((printerName) => {
            const printer = devices[printerName]
            const active = printerListening[printerName]
            return (
              <div
                key={printerName}
                className="flex flex-col gap-3 p-4 bg-gray-900 border border-gray-800 rounded-lg shadow-sm"
              >
                {/* Header */}
                <div className="flex justify-between items-center bg-gray-950/20 pb-2 border-b border-gray-800/40">
                  <div className="text-sm font-semibold text-gray-300">{printerName}</div>
                  
                  <div className="flex gap-2">
                    <select
                      value={printer.port}
                      onChange={(e) => handleDeviceChange(printerName, 'port', e.target.value)}
                      className="bg-gray-800 border border-gray-700/60 rounded px-2 py-0.5 text-xs text-gray-300 focus:outline-none cursor-pointer"
                    >
                      <option value="">-- Port --</option>
                      {comPorts.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>

                    <select
                      value={printer.baud}
                      onChange={(e) => handleDeviceChange(printerName, 'baud', e.target.value)}
                      className="bg-gray-800 border border-gray-700/60 rounded px-2 py-0.5 text-xs text-gray-300 focus:outline-none cursor-pointer"
                    >
                      <option value="9600">9600</option>
                      <option value="115200">115200</option>
                    </select>

                    <button
                      onClick={() => togglePrinter(printerName)}
                      className={`px-3 py-0.5 rounded text-xs font-bold transition-all shadow cursor-pointer ${
                        active
                          ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                      }`}
                    >
                      {active ? 'Listening...' : 'Listen'}
                    </button>
                  </div>
                </div>

                {/* Visual Label Tag Output Preview Box */}
                <div className="h-28 bg-gray-950 border border-gray-800 rounded p-3 overflow-hidden select-text text-emerald-400 shadow-inner font-mono text-[10px] leading-tight">
                  <pre className="whitespace-pre-wrap font-mono h-full overflow-y-auto">
                    {printerLabels[printerName]}
                  </pre>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
