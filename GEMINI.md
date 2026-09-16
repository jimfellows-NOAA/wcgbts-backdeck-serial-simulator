# **Project Architecture, Design Decisions, and Agent Guide**

Welcome, Agent. This document acts as the primary source of truth, technical memory, and architectural map for the **WCGBTS Hardware & Vessel Simulator** repository. Read this file completely to orient yourself before executing any modifications.

---

## **1. Project Overview & Purpose**
The purpose of this repository is to simulate real-time sensor measurements and network telemetry streams representing backdeck bottom-trawl survey systems (scales, scanners, printers, and trawl sensors) and vessel kinetics (GPS, heading, sounders). 
*   **Target Users**: NOAA Software Engineers and IT Admins developing and testing backdeck data collection systems (HookLogger, PyCollector) offline.
*   **Virtual Hardware Loop**: It translates user GUI inputs or math kinematics (10Hz loops) into raw NMEA-0183 sentences, TCP servers, UDP broadcasters, and virtual serial ports (com0com).

---

## **2. Repository Dual-Architecture**

This repository is maintained as a **dual-implementation parallel codebase**. Both apps must remain complete, fully functional, and independently buildable.

```
wcgbts-backdeck-serial-simulator/
├── main.py                    # Python Stable Entry Point
├── pyproject.toml             # Python uv Package manager config
├── Makefile                   # Python Build Automation script (make format, lint, build)
├── WCGBTS_Backdeck...spec      # PyInstaller spec for standalone .exe compilation
├── simulator_config.db        # SQLite database (physical file created on python startup)
│
├── electron-app/              # React, TypeScript, Electron Modern Implementation
│   ├── package.json           # Node.js dependencies & electron-builder targets
│   ├── vite.config.ts         # Vite build configuration (bundling React + Preload + Main)
│   ├── tsconfig.json          # TypeScript compilation configuration
│   ├── tailwind.config.js     # Tailwind CSS theme configurations
│   ├── electron/
│   │   ├── main.ts            # Node.js main process: Handles NMEA 10Hz loop & Bridges
│   │   └── preload.ts         # Safe contextBridge IPC interfaces
│   └── src/
│       ├── main.tsx           # React mounting entry point
│       ├── App.tsx            # Tab layouts, sidebar logs, scroll limits
│       └── components/        # Isolated tabs and native HTML5 Map Canvas
```

### **A. Core Stack Comparisons**

| Feature | Python & Tkinter (`main.py`) | React, TS, & Electron (`electron-app/`) |
| :--- | :--- | :--- |
| **Framework** | Native Python `tkinter` + `ttk` | Electron (V8/Chromium) + React 18 |
| **Styling** | Native `ttk` themes + packed grid frames | TailwindCSS (Responsive Utility Utility) |
| **Compilation** | `PyInstaller` (single executable) | `electron-builder` (portable Windows EXE) |
| **Database** | SQLite (`sqlite3` module built-in) | Local `vessel_simulator_config.json` inside User AppData |
| **GIS Mapping**| 2D Native `tk.Canvas` coordinate projector | 60 FPS HTML5 `<canvas>` coordinate projector |
| **Port Writing**| PySerial (`write` file streams) | Native Node `fs` file descriptor writers (`\\\\.\\COMX`) |

---

## **3. Key Telemetry & NMEA Sentence Generation**

The core vessel engine runs a **10Hz kinematics loop** (every 100ms) simulating:
*   **GPS Position**: Integrated using simple heading-bearing distance vectors (SOG converted to meters per second).
*   **Sensor Noise**: Injected via standard uniform random fluctuations mimicking natural wind, sea heave, roll, and pitch.
*   **NMEA-0183 Headers**:
    *   **GPS**: `$GPGLL`, `$GPHDT`, `$GPRMC`, `$GPVTG`
    *   **Trawl Sensors (ITI)**: `$IIDBS`, `$IIGLL`, `@IIHFB`, `@IIMTW`, `@IITDS`, `@IITPT`
    *   **Attitude / Heave**: `$PFEC,GPatt`, `$PFEC,GPhve`
    *   **Sounders (Depth)**: `$SDDBS`, `$SDDBT`, `$SDDPT`, `$SDMTW`
    *   **Wind**: `$WIMWV`
    *   **Simulated Marport Sensors**: `$PSIMP,D1`, `$PSIMTV80`

---

## **4. Database Schemas**

### **Python (`simulator_config.db` - SQLite)**
Stored directly in the workspace root:
1.  `settings`: Key-value pairs.
    *   `server_ip`: Default remote connection tests.
    *   `vessel_sim_speed`: Persistent default speed slider value.
    *   `vessel_sim_breadcrumbs`: Boolean trail visibility string (`"True"` or `"False"`).
2.  `tcp_com_mappings`: Forwarding COM bridge configuration.
    *   `tcp_port` (int), `com_port` (text), `baud_rate` (int)
3.  `tcp_udp_mappings`: Forwarding UDP bridge configuration.
    *   `tcp_port` (int), `udp_ip` (text), `udp_port` (int)
4.  `vessel_sim_ports`: Vessel simulation broadcast ports configuration.
    *   `device_name` (text), `port` (int), `protocol` (text), `hz` (int), `baud` (int)

### **React / Electron (`vessel_simulator_config.json`)**
Stored in Windows AppData folder under `app.getPath('userData')`. Holds keys for:
*   `server_ip`: Standard IP address string.
*   `com_bridges`: Array of `COMBridge` configs.
*   `udp_bridges`: Array of `UDPBridge` configs.
*   `vessel_ports`: Array of `BroadcastPort` configs.
*   `vessel_speed`: Default slider speed number.
*   `vessel_zoom`: Map projection pixels-per-degree scale multiplier.

---

## **5. Critical Windows Serial Port Namespace Rules**

Under Windows APIs, standard serial naming (such as `COM12` or `COM204`) fails with a `FileNotFoundError(2)` when opening port numbers higher than **9**.
*   **Rule**: Always format port paths on Windows using the namespace prefix: `\\\\.\\COMX`.
*   **Python implementation**:
    ```python
    port_path = f"\\\\.\\{raw_port}" if raw_port.startswith("COM") else raw_port
    ```
*   **Electron implementation**:
    ```typescript
    const portPath = process.platform === 'win32' ? `\\\\.\\${port.toUpperCase()}` : port
    ```

---

## **6. Build and Distribution Pipelines**

Both implementations are built to generate a single, standalone **Portable EXE** that can be distributed to users without installation:

### **Python (`PyInstaller` & spec)**
*   **Command**: `make build` (delegates to PyInstaller using `WCGBTS_Backdeck_Hardware_Simulator.spec`).
*   **Properties**: Standalone single-file, bundles `serial_port.ico` inside `sys._MEIPASS`, launches silently with no command-prompt window.

### **Electron (`electron-builder`)**
*   **Command**: `cd electron-app && npm run build`
*   **Properties**: Bundles React source using Vite, compiles TypeScript main process, compiles preload script, and uses `electron-builder` to compress the whole bundle into a single standalone portable executable:
    *   **Output folder**: `electron-app/dist-build/`
    *   **Build Target**: `portable` Windows EXE.

---

## **7. Guidelines for Modifying Code**

*   **Platform Safety**: Never import native platform bindings directly into Electron's renderer process. Always route operations (networking, file writing, com port access) through the preload IPC bridge to keep the Renderer completely sandboxed.
*   **Performance Safety**: 10Hz and 100Hz console logs will lock up Tkinter or Electron UI loops if they grow indefinitely. Always slice/limit log text areas to a maximum of **200 lines** on active UI insertions.
*   **Zero-Compile Serial Hack**: In Electron on Windows, opening COM ports using standard file handles (`fs.openSync('\\\\.\\COMX', 'r+')`) allows writing serial sentences with **zero native compiled modules**. Never add native `@serialport/bindings` to Electron unless explicitly requested, as this keeps the project 100% compile-free and portable across developer environments.
*   **Keep Dual-Status Sync**: When adding a feature to the Python Vessel Tab, replicate the visual experience, NMEA logging, and db storage in the Electron Tab to keep both implementations fully aligned.

*This documentation is compiled on Wednesday, September 16, 2026. Maintain these engineering standards on all subsequent turns.*
