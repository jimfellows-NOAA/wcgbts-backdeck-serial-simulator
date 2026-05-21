import os
import sys
import tkinter as tk
from datetime import datetime
from tkinter import messagebox, ttk

import serial
import serial.tools.list_ports


def resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller"""
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)


class HardwareSimulatorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("WCGBTS Backdeck Hardware Simulator")
        self.root.geometry("750x580")

        # Add the window icon (favicon)
        icon_path = resource_path("serial_port.ico")
        if os.path.exists(icon_path):
            self.root.iconbitmap(icon_path)

        self.devices = [
            "Marel M1100 - Large",
            "Marel M1100 - Small",
            "Scantrol FM-100",
            "Zebra Barcode Gun",
            "IchthyStick v3",
        ]

        self.port_vars = {}
        self.baud_vars = {}
        self.value_vars = {}

        self.create_widgets()

    def get_available_ports(self):
        """Returns a list of available COM ports, including known virtual ports."""
        detected_ports = [port.device for port in serial.tools.list_ports.comports()]
        virtual_ports = [f"COM{i}" for i in range(100, 126)] + [f"COM{i}" for i in range(200, 226)]
        all_ports = detected_ports + [p for p in virtual_ports if p not in detected_ports]
        return all_ports

    def refresh_ports(self):
        """Refreshes the COM port dropdowns for all devices."""
        available_ports = self.get_available_ports()
        for device in self.devices:
            self.port_vars[device]["values"] = available_ports
        self.log_message("System COM ports refreshed.")

    def log_message(self, message):
        """Appends a timestamped message to the terminal log window."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.config(state=tk.NORMAL)
        self.log_text.insert(tk.END, f"[{timestamp}] {message}\n")
        self.log_text.see(tk.END)  # Auto-scroll to bottom
        self.log_text.config(state=tk.DISABLED)

    def clear_log(self):
        """Clears the terminal log window."""
        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete(1.0, tk.END)
        self.log_text.config(state=tk.DISABLED)

    def create_widgets(self):
        # Header Frame
        header_frame = tk.Frame(self.root)
        header_frame.pack(fill=tk.X, pady=10, padx=10)
        tk.Label(
            header_frame,
            text="Device",
            width=20,
            anchor="w",
            font=("Arial", 10, "bold"),
        ).pack(side=tk.LEFT)
        tk.Label(
            header_frame,
            text="COM Port",
            width=12,
            anchor="w",
            font=("Arial", 10, "bold"),
        ).pack(side=tk.LEFT)
        tk.Label(header_frame, text="Baud", width=10, anchor="w", font=("Arial", 10, "bold")).pack(
            side=tk.LEFT
        )
        tk.Label(
            header_frame,
            text="Value to Send",
            width=20,
            anchor="w",
            font=("Arial", 10, "bold"),
        ).pack(side=tk.LEFT)

        tk.Button(header_frame, text="Refresh Ports", command=self.refresh_ports).pack(
            side=tk.RIGHT
        )

        # Device Rows
        available_ports = self.get_available_ports()
        baud_rates = ["4800", "9600", "19200", "38400", "115200"]

        for i, device in enumerate(self.devices):
            row_frame = tk.Frame(self.root)
            row_frame.pack(fill=tk.X, pady=5, padx=10)

            # Device Label
            tk.Label(row_frame, text=device, width=20, anchor="w").pack(side=tk.LEFT)

            # COM Port Dropdown
            port_cb = ttk.Combobox(row_frame, values=available_ports, width=10)
            port_cb.set(f"COM{201 + i}")  # Sets defaults: COM201, COM202, COM203, etc.
            port_cb.pack(side=tk.LEFT, padx=(0, 10))
            self.port_vars[device] = port_cb

            # Baud Rate Dropdown
            baud_cb = ttk.Combobox(row_frame, values=baud_rates, width=8)
            # Default to 4800 for Marel, 9600 for everything else
            if "Marel" in device:
                baud_cb.set("4800")
            else:
                baud_cb.set("9600")

            baud_cb.pack(side=tk.LEFT, padx=(0, 10))
            self.baud_vars[device] = baud_cb

            # Value Input
            val_entry = tk.Entry(row_frame, width=20)
            val_entry.pack(side=tk.LEFT, padx=(0, 15))
            self.value_vars[device] = val_entry

            # Send Button
            tk.Button(
                row_frame,
                text="Send",
                width=10,
                command=lambda d=device: self.send_data(d),
            ).pack(side=tk.LEFT)

        # Terminal Log Window
        log_frame = tk.LabelFrame(self.root, text="Transmission Log", padx=5, pady=5)
        log_frame.pack(fill=tk.BOTH, expand=True, pady=(15, 5), padx=10)

        # Terminal Output Box
        self.log_text = tk.Text(
            log_frame,
            height=10,
            state=tk.DISABLED,
            bg="black",
            fg="lightgreen",
            font=("Consolas", 10),
        )
        scrollbar = tk.Scrollbar(log_frame, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scrollbar.set)

        self.log_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Footer / Log Controls
        footer_frame = tk.Frame(self.root)
        footer_frame.pack(fill=tk.X, padx=10, pady=(0, 10))
        tk.Button(footer_frame, text="Clear Log", command=self.clear_log, width=10).pack(
            side=tk.RIGHT
        )

        self.log_message("Application started. Ready to transmit.")

    def format_sentence(self, device, value):
        """
        Formats the validated/rounded value into the exact device-specific serial sentence.
        """
        try:
            if device in ["Marel M1100 - Large", "Marel M1100 - Small"]:
                weight = float(value)
                tare = 0.00
                # Format: 8-char weight, " kg", 6-char tare, " kg\r\n"
                # Example output: "    5.00 kg  0.00 kg\r\n"
                sentence = f"{weight:>8.2f} kg{tare:>6.2f} kg\r\n"
                return sentence.encode("ascii")

            elif device in ["Scantrol FM-100", "IchthyStick v3"]:
                val_float = float(value)
                return f"{val_float:.1f}\r\n".encode("ascii")

            elif device == "Zebra Barcode Gun":
                return f"{value}\r\n".encode("ascii")

            else:
                return f"{value}\r\n".encode("ascii")

        except Exception as e:
            messagebox.showerror("Formatting Error", f"Error formatting data: {e}")
            return None

    def send_data(self, device):
        raw_port = self.port_vars[device].get().strip().upper()
        baud_rate = self.baud_vars[device].get().strip()
        value_str = self.value_vars[device].get().strip()

        if not raw_port:
            messagebox.showwarning("Missing Port", f"Please select a COM port for {device}.")
            return

        if not value_str:
            messagebox.showwarning("Missing Value", f"Please enter a value to send for {device}.")
            return

        # 1. Validation & Rounding Logic
        if device != "Zebra Barcode Gun":
            try:
                val_float = float(value_str)
            except ValueError:
                messagebox.showwarning("Invalid Input", f"{device} requires a numeric value.")
                return

            if device == "Scantrol FM-100":
                # Round to nearest 0.5
                val_float = round(val_float * 2.0) / 2.0
            else:
                # Round to nearest tenth for Marel and IchthyStick
                val_float = round(val_float, 1)

            # Update the UI field so the user sees the rounded value
            value_str = str(val_float)
            self.value_vars[device].delete(0, tk.END)
            self.value_vars[device].insert(0, value_str)

        # 2. COM Port Sanitization
        if raw_port.isdigit():
            raw_port = f"COM{raw_port}"
            self.port_vars[device].set(raw_port)

        if raw_port.startswith("COM"):
            port_path = f"\\\\.\\{raw_port}"
        else:
            port_path = raw_port

        # 3. Format and Send
        data_bytes = self.format_sentence(device, value_str)
        if not data_bytes:
            return

        try:
            # Added write_timeout=1 to prevent UI freezing if the buffer is full
            with serial.Serial(
                port_path, baudrate=int(baud_rate), timeout=1, write_timeout=1
            ) as ser:
                ser.write(data_bytes)
                ser.flush()  # Ensure it's pushed out of the OS buffer

            self.log_message(f"[{raw_port} @ {baud_rate}] {device} -> {repr(data_bytes)}")

        except serial.SerialTimeoutException:
            err_msg = f"Write timeout on {raw_port}. The receiving end might not be listening, causing the virtual buffer to fill up."
            self.log_message(f"ERROR: {err_msg}")
            messagebox.showerror("Serial Timeout", err_msg)
        except serial.SerialException as e:
            err_msg = f"Could not connect to {raw_port}."
            self.log_message(f"ERROR: {err_msg}")
            messagebox.showerror("Serial Error", f"{err_msg}\n\nDetails: {e}")
        except ValueError:
            messagebox.showerror("Baud Rate Error", "Baud rate must be an integer.")
        except Exception as e:
            messagebox.showerror("Error", f"An unexpected error occurred:\n\n{e}")


if __name__ == "__main__":
    root = tk.Tk()
    app = HardwareSimulatorApp(root)
    root.mainloop()
