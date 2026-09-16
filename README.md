# **WCGBTS Backdeck Hardware & Vessel Simulator**

A dual-implementation desktop simulation suite designed to test raw serial, TCP, and UDP data from NOAA Fisheries backdeck hardware and vessel GPS/NMEA telemetry.

This repository features two separate, fully functional parallel implementations:
1.  **Python & Tkinter (Core/Stable)**: A lightweight, standalone Python application.
2.  **React, TypeScript, & Electron (Modern)**: A beautiful, modern desktop suite with integrated 2D GIS Canvas map tracking and live simulated NMEA streams.

---

## **Supported Devices & Formats**

*   **Marel M1100 Electronic Scale - Large & Small**: Outputs a 20-character fixed-width string with Gross and Tare weights. Values are automatically rounded to the nearest tenth. (Default: 4800 baud)
*   **Scantrol FM-100**: Values are mathematically rounded to the nearest half (e.g., 1.0, 1.5, 2.0). (Default: 9600 baud)
*   **Zebra Barcode Gun (DS3608 / LI3608)**: Outputs alphanumeric strings, fully supporting Sudmant tissue project barcode formats. (Default: 9600 baud)
*   **AFSC IchthyStick v3**: Values are rounded to the nearest tenth. (Default: 9600 baud)
*   **Zebra Printers 1 & 2**: Background virtual COM listeners that capture and parse raw EPL label jobs, rendering printed tags inside the UI.
*   **NMEA-0183 Vessel Telemetry**: Dynamic simulation (10Hz) or replay of GPS, ITI Trawl, Echo Sounder, Wind, and Heave sentences over local network sockets (TCP/UDP) or virtual serial bridges.

---

## **🐍 Implementation 1: Python & Tkinter**

A self-contained, compile-free Python application running in a single-file structure (`main.py`) with zero bulky dependencies.

### **🚀 Package Management (uv)**
This project utilizes [uv](https://github.com/astral-sh/uv) for fast, reproducible Python environment management.

*   **Run in dev mode**:
    ```bash
    uv run python main.py
    ```

### **🛠️ Build & Task Commands (make)**
A Makefile is included to automate linting, formatting, and compiling:
*   `make build`  
    Compiles the application into a standalone, single-file Windows executable (`.exe`) inside `dist/` using PyInstaller.
*   `make clean`  
    Removes build/ and dist/ directories.
*   `make format`  
    Auto-formats the codebase using ruff.
*   `make lint`  
    Checks for errors and style violations using ruff.

---

## **⚛️ Implementation 2: React, TypeScript, & Electron**

A modern desktop application built inside the `electron-app/` subdirectory. It utilizes Electron's Chromium layer to provide an incredibly rich dashboard experience with an embedded GIS Map and live data consoles.

### **📁 Folder Structure**
All source code lives inside `electron-app/`:
*   `electron/main.ts`: Main process handling the 10Hz kinematics loop, background servers, COM files, and IPC bridge.
*   `src/components/`: Modular React components styled with **TailwindCSS**.
*   `src/components/VesselTab.tsx`: Houses the 60 FPS HTML5 Canvas Map and live 10Hz NMEA stream terminal.

### **🚀 Quickstart & Dev Mode**
Ensure you have [Node.js](https://nodejs.org) installed:
```bash
cd electron-app
npm install
npm run dev
```

### **📦 Compile Distributable Portable EXE**
To compile the React/TypeScript/Electron application into a single, standalone **Portable Windows `.exe`** with no installation required, run:
```bash
npm run build
```
The compiled output will be generated inside the `electron-app/dist-build/` directory!

---

## **🔀 Virtual COM Ports (com0com Setup)**

To simulate hardware locally without needing physical serial cables, this simulator relies on **com0com** to create virtual serial port pairs.

### **Setup Instructions (Requires IT Admin):**
1.  Run `setupg.exe` from the com0com installation directory.
2.  Add new Virtual Port Pairs. We map the **200-series** to the **100-series**:
    *   COM201 <--> COM101 (Marel Scale - Large)
    *   COM202 <--> COM102 (Marel Scale - Small)
    *   ...
    *   COM225 <--> COM125
3.  **Crucial Setting**: Ensure **"emulate baud rate"** and all other checkboxes remain **unchecked**.

### **Baud Rate Configuration on Windows**
*   **Windows API Pathing (Numbers > 9)**: Both implementations automatically prefix COM ports higher than 9 (like `COM204`) with the global namespace `\\.\` (e.g. `\\.\COM204`) so the Windows API can open them successfully.

---

# Disclaimer
This repository is a scientific product and is not official communication of the National Oceanic and Atmospheric Administration, or the United States Department of Commerce. All NOAA GitHub project content is provided on an "as is" basis and the user assumes responsibility for its use. Any claims against the Department of Commerce or Department of Commerce bureaus stemming from the use of this GitHub project will be governed by all applicable Federal law. Any reference to specific commercial products, processes, or services by service mark, trademark, manufacturer, or otherwise, does not constitute or imply their endorsement, recommendation or favoring by the Department of Commerce. The Department of Commerce seal and logo, or the seal and logo of a DOC bureau, shall not be used in any manner to imply endorsement of any commercial product or activity by DOC or the United States Government.