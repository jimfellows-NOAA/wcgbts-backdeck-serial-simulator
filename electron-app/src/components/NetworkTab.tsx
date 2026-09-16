import React, { useState, useEffect, useRef } from 'react'

const ENVIRONMENTS: Record<string, string> = {
  "Blue Vessel": "192.254.253",
  "Orange Vessel": "192.254.254",
  "White (Toronado)": "192.254.243",
  "Silver (Aggressor)": "192.254.241",
  "Red (Mirage)": "192.254.242",
  "Dev Mode": "127.0.0.1",
  "Custom Subnet": ""
}

const DEVICES: Record<string, string> = {
  "Wheelhouse Computer": "5",
  "Backdeck Computer (V:)": "2",
  "Galley Computer (K:)": "3",
  "Printer Moxa": "70",
  "Renasis LAN Radio Box": "98",
  "Moxa Box 1": "100",
  "Moxa Box 2": "102",  
  "Wheelhouse Moxa Server": "200",
  "Comm Box Moxa": "253",
  "Comm Box AP": "254"
}

const DRIVES: Record<string, string> = {
  "Local Drive (C:\\)": "C:\\",
  "External Backup (O:\\)": "O:\\",
  "Wheelhouse Mapped (W:\\)": "W:\\users\\survey\\downloads",
  "Backdeck Mapped (V:\\)": "V:\\users\\survey\\downloads",
  "Galley Mapped (K:\\)": "K:\\users\\survey\\downloads",
  "Galley Mapped (G:\\)": "G:\\users\\survey\\downloads"
}

interface SummaryItem {
  type: string
  name: string
  status: 'pass' | 'fail' | 'abort' | 'info'
}

export default function NetworkTab() {
  const [selectedEnv, setSelectedEnv] = useState('Blue Vessel')
  const [customSubnet, setCustomSubnet] = useState('192.168.1')
  
  // Devices Selection State
  const [selectedDevices, setSelectedDevices] = useState<Record<string, boolean>>(
    Object.keys(DEVICES).reduce((acc, k) => ({ ...acc, [k]: true }), {})
  )

  const [deviceOctets, setDeviceOctets] = useState<Record<string, string>>(DEVICES)

  // Drives Selection State
  const [selectedDrives, setSelectedDrives] = useState<Record<string, boolean>>(
    Object.keys(DRIVES).reduce((acc, k) => ({ ...acc, [k]: true }), {})
  )

  const [fileSize, setFileSize] = useState(5) // in MB
  const [isRunning, setIsRunning] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')
  
  // Terminal logs state
  const [detailedLogs, setDetailedLogs] = useState<string[]>([])
  const [summaryLogs, setSummaryLogs] = useState<SummaryItem[]>([])

  const abortRef = useRef(false)
  const detailedLogEndRef = useRef<HTMLDivElement>(null)
  const summaryLogEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (detailedLogEndRef.current) {
      detailedLogEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [detailedLogs])

  useEffect(() => {
    if (summaryLogEndRef.current) {
      summaryLogEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [summaryLogs])

  const getTargetIp = (octet: string) => {
    if (selectedEnv === 'Dev Mode') return '127.0.0.1'
    if (selectedEnv === 'Custom Subnet') {
      return `${customSubnet.trim()}.${octet}`
    }
    return `${ENVIRONMENTS[selectedEnv]}.${octet}`
  }

  const logDetail = (msg: string) => {
    setDetailedLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} - ${msg}\n`])
  }

  const addSummary = (type: string, name: string, status: 'pass' | 'fail' | 'abort' | 'info') => {
    setSummaryLogs((prev) => [...prev, { type, name, status }])
  }

  const handleToggleAllDevices = (checked: boolean) => {
    setSelectedDevices(Object.keys(DEVICES).reduce((acc, k) => ({ ...acc, [k]: checked }), {}))
  }

  const handleToggleAllDrives = (checked: boolean) => {
    setSelectedDrives(Object.keys(DRIVES).reduce((acc, k) => ({ ...acc, [k]: checked }), {}))
  }

  const handleCancel = () => {
    abortRef.current = true
    logDetail('[!] CANCEL INITIATED. Killing current operations...')
    setProgressMsg('Cancelling...')
  }

  // Map Network Drive Utility
  const handleMapDrive = async (driveLetter: string, octet: string) => {
    if (selectedEnv === 'Custom Subnet') {
      const trimmed = customSubnet.trim()
      const parts = trimmed.split('.')
      if (parts.length !== 3 || parts.some((p) => isNaN(parseInt(p)) || parseInt(p) < 0 || parseInt(p) > 255)) {
        alert('Please enter a valid 3-octet custom subnet (e.g. 192.168.1).')
        return
      }
    }

    setIsRunning(true)
    abortRef.current = false
    setProgressMsg(`Mapping ${driveLetter}: Drive...`)
    setDetailedLogs([])
    setSummaryLogs([])

    const targetIp = getTargetIp(octet)
    logDetail(`--- ATTEMPTING TO MAP ${driveLetter}: DRIVE ---`)
    logDetail(`Target UNC path: \\\\${targetIp}\\c`)
    logDetail(`Disconnecting any pre-existing ${driveLetter}: mapping...`)

    const res = await window.electronAPI.mapDrive(driveLetter, targetIp)

    if (abortRef.current) {
      addSummary('Mapping', `${driveLetter}: -> ${targetIp}`, 'abort')
      logDetail('[ABORTED] Drive mapping canceled by user.')
      setIsRunning(false)
      setProgressMsg('')
      return
    }

    if (res.success) {
      logDetail(`[SUCCESS] net use ${driveLetter}: drive mapped successfully.`)
      logDetail(res.output)
      addSummary('Mapping', `${driveLetter}: Drive mapped successfully!`, 'pass')
    } else {
      logDetail(`[ERROR] Failed to map ${driveLetter}: Drive.`)
      logDetail(`Windows error output:\n${res.output}`)
      addSummary('Mapping', `${driveLetter}: Drive failed to map.`, 'fail')
    }

    setIsRunning(false)
    setProgressMsg('')
  }

  // Core Diagnostics Execution Loop
  const handleRunDiagnostics = async () => {
    if (selectedEnv === 'Custom Subnet') {
      const trimmed = customSubnet.trim()
      const parts = trimmed.split('.')
      if (parts.length !== 3 || parts.some((p) => isNaN(parseInt(p)) || parseInt(p) < 0 || parseInt(p) > 255)) {
        alert('Please enter a valid 3-octet custom subnet (e.g. 192.168.1).')
        return
      }
    }

    setIsRunning(true)
    abortRef.current = false
    setDetailedLogs([])
    setSummaryLogs([])
    setProgressMsg('Running network tests...')

    logDetail(`=== STARTING DIAGNOSTICS: ${selectedEnv.toUpperCase()} ===\n`)
    logDetail('--- NETWORK PING TESTS ---')

    // 1. Run Pings sequentially
    for (const [devName, octet] of Object.entries(deviceOctets)) {
      if (abortRef.current) break

      if (selectedDevices[devName]) {
        const ip = getTargetIp(octet)
        logDetail(`Pinging ${devName} (${ip})...`)
        setProgressMsg(`Pinging ${devName}...`)

        const res = await window.electronAPI.runPing(ip)

        if (abortRef.current) {
          addSummary('Ping', devName, 'abort')
          break
        }

        if (res.success) {
          // Extract loss and latency summaries
          const lines = res.output.split('\n')
          const lossLine = lines.find((l) => l.includes('Loss') || l.includes('Lost'))
          const avgLine = lines.find((l) => l.includes('Average'))

          if (lossLine) logDetail(`   [OK] Loss: ${lossLine.trim()}`)
          if (avgLine) logDetail(`   [OK] Latency: ${avgLine.trim()}`)
          
          addSummary('Ping', devName, 'pass')
        } else {
          logDetail('   [FAIL] Device unreachable or ICMP blocked.')
          addSummary('Ping', devName, 'fail')
        }
      }
    }

    // 2. Run Drive Write Speed Tests sequentially
    if (!abortRef.current) {
      logDetail('\n' + '='.repeat(45) + '\n')
      logDetail('--- DRIVE WRITE SPEED TESTS ---')
      setProgressMsg('Running drive speed tests...')

      for (const [driveName, path] of Object.entries(DRIVES)) {
        if (abortRef.current) break

        if (selectedDrives[driveName]) {
          logDetail(`Testing Write Speed: ${driveName} (Size: ${fileSize}MB)...`)
          setProgressMsg(`Testing ${driveName}...`)

          const res = await window.electronAPI.runDriveSpeedTest(path, fileSize)

          if (abortRef.current) {
            addSummary('Speed', driveName, 'abort')
            break
          }

          if (res.success) {
            logDetail(`   [OK] Duration: ${res.duration}s | Calculated Write Speed: ${res.speedMbSec} MB/s`)
            addSummary('Speed', `${driveName} (${res.speedMbSec} MB/s)`, 'pass')
          } else {
            logDetail(`   [FAIL] path is not accessible or permission denied.`)
            logDetail(`   Error: ${res.msg}`)
            addSummary('Speed', driveName, 'fail')
          }
        }
      }
    }

    if (abortRef.current) {
      logDetail('\n=== DIAGNOSTICS ABORTED BY USER ===')
    } else {
      logDetail('\n=== DIAGNOSTICS COMPLETE ===')
      setProgressMsg('')
    }

    setIsRunning(false)
  }

  // Export logs utility
  const handleExportLogs = async () => {
    const summaryText = summaryLogs
      .map((s) => `[${s.status.toUpperCase()}] ${s.type}: ${s.name}`)
      .join('\n')
    const detailText = detailedLogs.join('')

    const res = await window.electronAPI.exportDiagLogs(summaryText, detailText)
    alert(res.msg)
  }

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      {/* 1. Environment Radio Panel */}
      <div className="bg-gray-900 border border-gray-800 p-3 rounded-lg shadow-sm shrink-0">
        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block mb-2">
          1. Select Environment Target
        </span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
          {Object.keys(ENVIRONMENTS).map((env) => (
            <label key={env} className="flex items-center gap-1.5 text-xs text-gray-300 font-semibold cursor-pointer select-none">
              <input
                type="radio"
                name="env-radio"
                value={env}
                checked={selectedEnv === env}
                onChange={() => setSelectedEnv(env)}
                disabled={isRunning}
                className="accent-orange-500 h-4 w-4 cursor-pointer"
              />
              {env}
              {env !== 'Custom Subnet' && env !== 'Dev Mode' && (
                <span className="text-[10px] text-gray-500 font-mono">
                  ({ENVIRONMENTS[env]}.X)
                </span>
              )}
              {env === 'Dev Mode' && (
                <span className="text-[10px] text-gray-500 font-mono">
                  (127.0.0.1)
                </span>
              )}
            </label>
          ))}

          {/* Conditional Custom Subnet Input */}
          {selectedEnv === 'Custom Subnet' && (
            <div className="flex items-center gap-1.5 ml-2 bg-gray-950/40 px-2 py-0.5 rounded border border-gray-800 shrink-0">
              <span className="text-[9px] font-bold text-gray-500 uppercase">Subnet Prefix:</span>
              <input
                type="text"
                value={customSubnet}
                onChange={(e) => setCustomSubnet(e.target.value)}
                disabled={isRunning}
                placeholder="e.g. 192.168.1"
                className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none focus:border-orange-500 w-28 font-mono"
              />
              <span className="text-[10px] text-gray-500 font-mono">.X</span>
            </div>
          )}
        </div>
      </div>

      {/* 2. Selection Settings Column */}
      <div className="grid grid-cols-2 gap-3 shrink-0">
        {/* Devices Checkboxes */}
        <div className="bg-gray-900/50 border border-gray-800 p-3 rounded-lg flex flex-col min-h-0">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
              2. Devices to Ping
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleToggleAllDevices(true)}
                disabled={isRunning}
                className="text-[9px] font-bold text-orange-400 hover:text-orange-300 disabled:opacity-50 cursor-pointer"
              >
                All
              </button>
              <span className="text-gray-600 text-[9px]">|</span>
              <button
                onClick={() => handleToggleAllDevices(false)}
                disabled={isRunning}
                className="text-[9px] font-bold text-gray-400 hover:text-gray-300 disabled:opacity-50 cursor-pointer"
              >
                None
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 overflow-y-auto max-h-24 p-1">
            {Object.keys(DEVICES).map((d) => (
              <div key={d} className="flex items-center justify-between gap-1 bg-gray-950/20 px-1.5 py-0.5 rounded border border-gray-800/50">
                <label className="flex items-center gap-1.5 text-[10px] text-gray-300 font-semibold cursor-pointer select-none truncate flex-grow">
                  <input
                    type="checkbox"
                    checked={selectedDevices[d] || false}
                    onChange={(e) => setSelectedDevices((prev) => ({ ...prev, [d]: e.target.checked }))}
                    disabled={isRunning}
                    className="rounded border-gray-700 text-orange-500 focus:ring-orange-500 bg-gray-800 cursor-pointer w-3 h-3 shrink-0"
                  />
                  <span className="truncate" title={d}>{d}</span>
                </label>
                <div className="flex items-center shrink-0 font-mono text-[9px] text-gray-500">
                  <span className="mr-0.5">.</span>
                  <input
                    type="text"
                    value={deviceOctets[d] || ''}
                    onChange={(e) => {
                      const val = e.target.value
                      setDeviceOctets((prev) => ({ ...prev, [d]: val }))
                    }}
                    disabled={isRunning}
                    className="w-7 bg-gray-800 border border-gray-700 rounded text-center text-gray-300 focus:outline-none focus:border-orange-500 py-0.5 text-[9px] font-bold"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Drives & File Size Selector */}
        <div className="bg-gray-900/50 border border-gray-800 p-3 rounded-lg flex flex-col justify-between min-h-0">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
              3. Drives to Speed Test
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleToggleAllDrives(true)}
                disabled={isRunning}
                className="text-[9px] font-bold text-orange-400 hover:text-orange-300 disabled:opacity-50 cursor-pointer"
              >
                All
              </button>
              <span className="text-gray-600 text-[9px]">|</span>
              <button
                onClick={() => handleToggleAllDrives(false)}
                disabled={isRunning}
                className="text-[9px] font-bold text-gray-400 hover:text-gray-300 disabled:opacity-50 cursor-pointer"
              >
                None
              </button>
            </div>
          </div>

          <div className="flex gap-2 items-center mb-1.5 bg-gray-950/30 p-1.5 rounded border border-gray-800/40">
            <span className="text-[10px] text-gray-400 font-semibold shrink-0">Test File Size:</span>
            <input
              type="range"
              min="1"
              max="50"
              value={fileSize}
              onChange={(e) => setFileSize(parseInt(e.target.value))}
              disabled={isRunning}
              className="flex-grow accent-orange-500 cursor-pointer h-1 rounded appearance-none bg-gray-800"
            />
            <span className="text-[10px] font-mono font-bold text-orange-400 w-10 text-right">{fileSize} MB</span>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 overflow-y-auto max-h-16 p-1">
            {Object.keys(DRIVES).map((dr) => (
              <label key={dr} className="flex items-center gap-2 text-[10px] text-gray-300 font-semibold cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={selectedDrives[dr] || false}
                  onChange={(e) => setSelectedDrives((prev) => ({ ...prev, [dr]: e.target.checked }))}
                  disabled={isRunning}
                  className="rounded border-gray-700 text-orange-500 focus:ring-orange-500 bg-gray-800 cursor-pointer w-3.5 h-3.5"
                />
                {dr}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* 3. Run Controls / Progress Bar */}
      <div className="flex flex-col items-center gap-2 bg-gray-950/25 border border-gray-800 p-2.5 rounded-lg shrink-0">
        <div className="flex gap-4 w-full justify-center">
          <button
            onClick={handleRunDiagnostics}
            disabled={isRunning}
            className="px-8 py-1.5 bg-rose-800 hover:bg-rose-700 disabled:opacity-50 text-white rounded text-xs font-bold transition shadow uppercase tracking-wider cursor-pointer"
          >
            Run Selected Diagnostics
          </button>
          <button
            onClick={handleCancel}
            disabled={!isRunning}
            className="px-6 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-30 text-white rounded text-xs font-bold transition shadow uppercase tracking-wider cursor-pointer"
          >
            Cancel
          </button>
        </div>
        {isRunning && (
          <div className="flex flex-col items-center gap-1 w-full max-w-md mt-1 animate-pulse">
            <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden relative border border-gray-700/35">
              <div className="h-full bg-orange-500 w-1/3 rounded-full absolute animate-infinite-slide"></div>
            </div>
            <span className="text-[10px] font-semibold text-orange-400 tracking-wide uppercase">
              {progressMsg || 'Running tests...'}
            </span>
          </div>
        )}
      </div>

      {/* 4. Quick Tools Bar */}
      <div className="flex items-center justify-between bg-gray-900/40 border border-gray-800 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-gray-500 uppercase">Quick Tools:</span>
          <button
            onClick={() => handleMapDrive('W', '5')}
            disabled={isRunning}
            className="px-2 py-0.5 border border-gray-700 hover:border-gray-500 disabled:opacity-50 rounded text-[10px] text-gray-300 transition cursor-pointer"
          >
            Map W: (Wheelhouse)
          </button>
          <button
            onClick={() => handleMapDrive('V', '2')}
            disabled={isRunning}
            className="px-2 py-0.5 border border-gray-700 hover:border-gray-500 disabled:opacity-50 rounded text-[10px] text-gray-300 transition cursor-pointer"
          >
            Map V: (Backdeck)
          </button>
          <button
            onClick={() => handleMapDrive('K', '3')}
            disabled={isRunning}
            className="px-2 py-0.5 border border-gray-700 hover:border-gray-500 disabled:opacity-50 rounded text-[10px] text-gray-300 transition cursor-pointer"
          >
            Map K: (Galley)
          </button>
          <button
            onClick={() => handleMapDrive('G', '3')}
            disabled={isRunning}
            className="px-2 py-0.5 border border-gray-700 hover:border-gray-500 disabled:opacity-50 rounded text-[10px] text-gray-300 transition cursor-pointer"
          >
            Map G: (Galley)
          </button>
        </div>
        <button
          onClick={handleExportLogs}
          disabled={detailedLogs.length === 0}
          className="px-3.5 py-0.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded text-[10px] font-bold transition cursor-pointer"
        >
          Export Logs
        </button>
      </div>

      {/* 5. Live Feed Displays (Side by Side) */}
      <div className="flex-grow grid grid-cols-2 gap-3 overflow-hidden min-h-0">
        {/* Left: Detailed Logs terminal */}
        <div className="border border-gray-800 bg-gray-950 rounded-lg p-3 flex flex-col overflow-hidden">
          <span className="text-[10px] font-bold text-gray-400 tracking-wider mb-2 block border-b border-gray-800/40 pb-1 shrink-0">
            DETAILED LOGS
          </span>
          <div className="flex-grow overflow-y-auto font-mono text-[10px] text-emerald-400 leading-tight whitespace-pre select-text selection:bg-emerald-950">
            {detailedLogs.join('') || <span className="text-gray-600 italic">Select tests and click Run to begin diagnostics log...</span>}
            <div ref={detailedLogEndRef} />
          </div>
        </div>

        {/* Right: Summary Results Panel */}
        <div className="border border-gray-800 bg-gray-950 rounded-lg p-3 flex flex-col overflow-hidden">
          <span className="text-[10px] font-bold text-gray-400 tracking-wider mb-2 block border-b border-gray-800/40 pb-1 shrink-0">
            SUMMARY RESULTS
          </span>
          <div className="flex-grow overflow-y-auto font-mono text-[11px] leading-tight select-text space-y-1">
            {summaryLogs.length === 0 ? (
              <span className="text-gray-600 italic">Test results summary will print here...</span>
            ) : (
              summaryLogs.map((s, index) => {
                const statusColors = {
                  pass: 'text-green-400 font-bold',
                  fail: 'text-red-500 font-bold animate-pulse',
                  abort: 'text-orange-400 font-bold',
                  info: 'text-blue-400 font-bold'
                }
                const statusLabels = {
                  pass: '[PASS]',
                  fail: '[FAIL]',
                  abort: '[ABORT]',
                  info: '[INFO]'
                }
                return (
                  <div key={index} className="flex gap-2 py-0.5 border-b border-gray-900/30">
                    <span className={statusColors[s.status]}>{statusLabels[s.status]}</span>
                    <span className="text-gray-400">{s.type}:</span>
                    <span className="text-gray-100 font-bold">{s.name}</span>
                  </div>
                )
              })
            )}
            <div ref={summaryLogEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
