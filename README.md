# **WCGBTS Backdeck Hardware Simulator**

A Python desktop application built with Tkinter to simulate raw serial data from NOAA Fisheries backdeck hardware.

## **Supported Devices & Formats**

* **Marel M1100 Electronic Scale \- Large & Small**: Outputs a 20-character fixed-width string with Gross and Tare weights. Values are automatically rounded to the nearest tenth. (Default: 4800 baud)  
* **Scantrol FM-100**: Values are mathematically rounded to the nearest half (e.g., 1.0, 1.5, 2.0). (Default: 9600 baud)  
* **Zebra Barcode Gun (DS3608 / LI3608)**: Outputs alphanumeric strings, fully supporting Sudmant tissue project barcode formats. (Default: 9600 baud)  
* **AFSC IchthyStick v3**: Values are rounded to the nearest tenth. (Default: 9600 baud)

## **🚀 Package Management (uv)**

This project utilizes [uv](https://github.com/astral-sh/uv) for fast, reproducible Python environment management.

* **Initialization**: The project is configured via pyproject.toml (requires Python \>= 3.13).  
* **Run the application in dev mode**:  
  uv run python main.py

## **🛠️ Build & Task Commands (make)**

A Makefile is included to automate linting, formatting, and compiling so you don't have to remember the underlying tool commands.

* make build  
  Compiles the application into a standalone, single-file Windows executable (.exe) using PyInstaller and your .spec file. Bundles the custom serial\_port.ico and suppresses the background console.  
* make clean  
  Removes the build/ and dist/ directories and runs uv cache clean to prevent caching issues.  
* make format  
  Auto-formats the codebase to industry standards using ruff format.  
* make lint  
  Checks for logic errors and style violations using ruff check.

## **🔀 Virtual COM Ports (com0com Setup)**

To simulate hardware locally without needing a desk full of physical null-modem cables, this simulator relies on **com0com** to create virtual serial port pairs.

### **Setup Instructions (Requires IT Admin):**

1. Run setupg.exe from the com0com installation directory.  
2. Add new Virtual Port Pairs. We map the **200-series** to the **100-series**:  
   * COM201 \<--\> COM101  
   * COM202 \<--\> COM102  
   * ...  
   * COM225 \<--\> COM125  
3. **Crucial Setting**: Ensure **"emulate baud rate"** and all other checkboxes remain **unchecked**.

### **A Note on Baud Rate**

Because "emulate baud rate" is disabled in the com0com setup, the virtual ports act as a direct, unthrottled memory pipe. The simulator and receiver technically do not need to operate at the same baud rate over virtual ports. However, the simulator forces you to select an accurate Baud Rate (4800 for Marel, 9600 for others) to satisfy the NOAA receiving software's strict connection validation and to future-proof the tool for testing with physical serial cables.

## **🎣 Interfacing with Backdeck Software**

1. **Launch the Simulator**: Open the compiled WCGBTS\_Hardware\_Simulator.exe.  
2. **Assign Ports (Sender)**: Configure the simulator devices to transmit on the **higher** numbered ports (e.g., set the Marel Large scale to COM201).  
3. **Configure HookLogger / Pycollector (Receiver)**: Set your NOAA testing software to listen on the corresponding **lower** paired port (e.g., tell the app to expect the Marel Large scale on COM101).  
4. **Simulate**: Enter a measurement value in the simulator and click **Send**. The simulator handles the formatting, rounding, and NMEA string generation automatically.  
5. **Verify**: Check the simulator's Transmission Log to see the raw bytes sent, and verify that HookLogger/Pycollector successfully parses the incoming data.

# Disclaimer
This repository is a scientific product and is not official communication of the National Oceanic and Atmospheric Administration, or the United States Department of Commerce. All NOAA GitHub project content is provided on an "as is" basis and the user assumes responsibility for its use. Any claims against the Department of Commerce or Department of Commerce bureaus stemming from the use of this GitHub project will be governed by all applicable Federal law. Any reference to specific commercial products, processes, or services by service mark, trademark, manufacturer, or otherwise, does not constitute or imply their endorsement, recommendation or favoring by the Department of Commerce. The Department of Commerce seal and logo, or the seal and logo of a DOC bureau, shall not be used in any manner to imply endorsement of any commercial product or activity by DOC or the United States Government.