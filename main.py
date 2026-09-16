import math
import os
import random
import re
import socket
import sqlite3
import sys
import threading
import time
import tkinter as tk
from collections import deque
from datetime import datetime, timezone
from tkinter import messagebox, ttk

import serial
import serial.tools.list_ports

# Optional GIS and replay dependencies
try:
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    from shapely.geometry import Point
    HAS_REPLAY_GIS = True
except ImportError:
    HAS_REPLAY_GIS = False


def resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller"""
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)


# =====================================================================
# --- VESSEL SIMULATOR BACKEND STATE & LOGIC ---
# =====================================================================

DEVICE_GROUPS = {
    "GPS": ["$GPGLL", "$GPHDT", "$GPRMC", "$GPVTG"],
    "ITI_Trawl_System": ["$IIDBS", "$IIGLL", "@IIHFB", "@IIMTW", "@IITDS", "@IITPT"],
    "Furuno_Attitude_Heave": ["$PFEC,GPatt", "$PFEC,GPhve"],
    "Echosounder_Depth_Temp": ["$SDDBS", "$SDDBT", "$SDDPT", "$SDMTW"],
    "$PSIMP,D1": ["$PSIMP,D1"],
    "$PSIMTV80": ["$PSIMTV80"],
    "$WIMWV": ["$WIMWV"]
}

SENTENCE_TO_DEVICE = {
    sentence: device for device, sentences in DEVICE_GROUPS.items() for sentence in sentences
}

GEOFENCE_BOUNDARY = None


def setup_geofence():
    """Loads the shapefile and creates an inward-buffered boundary for geofencing."""
    global GEOFENCE_BOUNDARY
    if not HAS_REPLAY_GIS:
        return
    shapefile_path = os.path.join('data', 'WCGBTS_Grid_v2008_dd.shp')
    if not os.path.exists(shapefile_path):
        return
    try:
        gdf = gpd.read_file(shapefile_path)
        gdf_proj = gdf.to_crs(epsg=32610)
        boundary_proj = gdf_proj.unary_union.buffer(-185.2)  # 0.1 NM buffer
        GEOFENCE_BOUNDARY = gpd.GeoSeries([boundary_proj], crs="EPSG:32610")
    except Exception:
        GEOFENCE_BOUNDARY = None


class AppState:
    def __init__(self):
        self.lock = threading.Lock()
        self.vessel_state = {
            "lat": 38.035, "lon": -123.394, "sog_knots": 0.0, "heading": 0.0, "track": 0.0,
            "seafloor_depth": 0.0, "pitch": 0.0, "roll": 0.0, "heave": 0.0,
            "default_speed": 10.0, "area_swept_kpi": 0.0, "breadcrumb_enabled": True
        }
        self.track_history = deque(maxlen=200)
        self.server_threads = {}
        self.stop_events = {}
        self.latest_sentences = {key: "" for key in SENTENCE_TO_DEVICE.keys()}
        self.active_ports = {}
        self.data_source_thread = None
        self.data_source_stop_event = None
        self.current_mode = "Idle"
        self.current_file = ""
        self.app = None  # Reference to Tkinter App for NMEA logging

    def clear_history(self):
        self.track_history.clear()


STATE = AppState()

# --- Generator Declarations ---
GENERATOR_FUNCTIONS = {}


def register_generator(header):
    def decorator(func):
        GENERATOR_FUNCTIONS[header] = func
        return func
    return decorator


def generate_checksum(sentence):
    if sentence.startswith(('$', '@', '!')):
        sentence = sentence[1:]
    checksum = 0
    for char in sentence:
        checksum ^= ord(char)
    return format(checksum, '02X')


def decimal_to_nmea_lat(dec_lat):
    direction, dec_lat = ('N', dec_lat) if dec_lat >= 0 else ('S', abs(dec_lat))
    return f"{int(dec_lat):02d}{(dec_lat - int(dec_lat)) * 60:07.4f}", direction


def decimal_to_nmea_lon(dec_lon):
    direction, dec_lon = ('E', dec_lon) if dec_lon >= 0 else ('W', abs(dec_lon))
    return f"{int(dec_lon):03d}{(dec_lon - int(dec_lon)) * 60:07.4f}", direction


@register_generator("$GPGLL")
def gen_gpgll(state, now):
    lat_str, lat_dir = decimal_to_nmea_lat(state['lat'])
    lon_str, lon_dir = decimal_to_nmea_lon(state['lon'])
    body = f"GPGLL,{lat_str},{lat_dir},{lon_str},{lon_dir},{now.strftime('%H%M%S.%f')[:-4]},A,A"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$GPHDT")
def gen_gphdt(state, now):
    body = f"GPHDT,{state['heading']:.1f},T"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$GPRMC")
def gen_gprmc(state, now):
    lat_str, lat_dir = decimal_to_nmea_lat(state['lat'])
    lon_str, lon_dir = decimal_to_nmea_lon(state['lon'])
    body = (
        f"GPRMC,{now.strftime('%H%M%S')},A,{lat_str},{lat_dir},{lon_str},{lon_dir},"
        f"{state['sog_knots']:.2f},{state['track']:.1f},{now.strftime('%d%m%y')},,,A"
    )
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$GPVTG")
def gen_gpvtg(state, now):
    body = f"GPVTG,{state['track']:.1f},T,,M,{state['sog_knots']:.2f},N,{state['sog_knots'] * 1.852:.2f},K,A"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$IIDBS")
def gen_iidbs(state, now):
    body = f"IIDBS,{state['seafloor_depth'] - random.uniform(5, 20):.1f},M"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$IIGLL")
def gen_iigll(state, now):
    lat_str, lat_dir = decimal_to_nmea_lat(state['lat'] - 0.0005)
    lon_str, lon_dir = decimal_to_nmea_lon(state['lon'] - 0.0005)
    body = f"IIGLL,{lat_str},{lat_dir},{lon_str},{lon_dir},{now.strftime('%H%M%S.%f')[:-4]},A"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("@IIHFB")
def gen_iihfb(state, now):
    return f"@IIHFB,{random.uniform(4.0, 7.0):.1f},M,{random.uniform(1.0, 5.0):.1f},M\r\n"


@register_generator("@IIMTW")
def gen_iimtw(state, now):
    return f"@IIMTW,{random.uniform(2.0, 8.5):.1f},C\r\n"


@register_generator("@IITDS")
def gen_iitds(state, now):
    return f"@IITDS,{random.uniform(40.0, 75.0):.1f},M\r\n"


@register_generator("@IITPT")
def gen_iitpt(state, now):
    body = (
        f"IITPT,{random.uniform(300, 600):.1f},M,{(state['heading'] + 180) % 360:.1f},T,"
        f"{state['seafloor_depth'] - random.uniform(5, 20):.1f},M"
    )
    return f"@{body}\r\n"


@register_generator("$PFEC,GPatt")
def gen_patt(state, now):
    body = f"PFEC,GPatt,{state['heading']:.2f},{state['pitch']:.2f},{state['roll']:.2f}"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$PFEC,GPhve")
def gen_phve(state, now):
    body = f"PFEC,GPhve,{state['heave']:.2f},A"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$PSIMP,D1")
def gen_psimpd1(state, now):
    now_utc = datetime.now(timezone.utc)
    utc_time, utc_date = now_utc.strftime("%H%M%S.%f")[:-3], now_utc.strftime("%d%m%y")
    base = ["PSIMP", "D1", utc_time, utc_date]
    params = [
        ('H1', '2', lambda s: random.uniform(15 * .95, 15 * 1.05)),
        ('S1', '4', lambda s: random.uniform(15 * .95, 15 * 1.05)),
        ('S1', '6', lambda s: random.uniform(35 * .95, 35 * 1.05)),
        ('D1', '8', lambda s: s.get('seafloor_depth', 100) + 15),
    ]
    sentences = []
    for m_type, f_chan, value_gen in params:
        f = list(base)
        f.extend([m_type, "M", "1", "1", f_chan, f"{value_gen(state):.2f}",
                  "0.0", "21", "0", "60.0", "30.0", "20.0", "0", "0"])
        body = ",".join(f)
        sentences.append(f"${body}*{generate_checksum(body)}\r\n")
    return sentences


@register_generator("$PSIMTV80")
def gen_psimtv80(state, now):
    time_str = now.strftime("%H%M%S")
    date_str = now.strftime("%d%m%y")
    base = ["PSIMTV80", time_str, date_str, "", "", "", "", "", "", "", "", "", "", "", ""]
    params = [
        ('03', 'a7', '', lambda s: s.get('seafloor_depth', 115) - 15),
        ('12', 'a7', '', lambda s: random.uniform(15 * .95, 15 * 1.05)),
        ('01', 'a5', 'a6', lambda s: random.uniform(14 * .95, 14 * 1.05)),
        ('01', 'a1', 'a2', lambda s: random.uniform(35 * .95, 35 * 1.05)),
        ('10', 'a7', '', lambda s: random.uniform(12 * .95, 12 * 1.05)),
    ]
    sentences = []
    for code, fr, to, v_gen in params:
        fields = list(base)
        fields.extend([code, fr, to, f"{v_gen(state):.2f}", "10", "0"])
        body = ",".join(fields)
        sentences.append(f"${body}*{generate_checksum(body)}\r\n")
    return sentences


@register_generator("$SDDBS")
def gen_sddbs(state, now):
    d_m = state['seafloor_depth']
    body = f"SDDBS,{d_m * 3.28:.1f},f,{d_m:.1f},M,{d_m * 0.54:.1f},F"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$SDDBT")
def gen_sddbt(state, now):
    d_m = state['seafloor_depth']
    body = f"SDDBT,{d_m * 3.28:.1f},f,{d_m:.1f},M,{d_m * 0.54:.1f},F"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$SDDPT")
def gen_sddpt(state, now):
    d_m = state['seafloor_depth']
    offset = 0.0
    body = f"SDDPT,{d_m:.1f},{offset:.1f}"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$SDMTW")
def gen_sdmtw(state, now):
    body = f"SDMTW,{random.uniform(9.0, 15.0):.1f},C"
    return f"${body}*{generate_checksum(body)}\r\n"


@register_generator("$WIMWV")
def gen_wimwv(state, now):
    t_dir, t_spd = random.uniform(0, 359.9), random.uniform(5.0, 25.0)
    r_ang, r_spd = (t_dir - state['track'] + random.uniform(-30, 30)) % 360, abs(t_spd + random.uniform(-2, 2))
    t_body, r_body = f"WIMWV,{t_dir:.1f},T,{t_spd:.1f},N,A", f"WIMWV,{r_ang:.1f},R,{r_spd:.1f},N,A"
    return f"${t_body}*{generate_checksum(t_body)}\r\n" + f"${r_body}*{generate_checksum(r_body)}\r\n"


# --- Kinematics Math ---
def calculate_destination(lat, lon, bearing, distance_m):
    R = 6371e3
    lat_rad, lon_rad, bearing_rad = math.radians(lat), math.radians(lon), math.radians(bearing)
    d = distance_m / R
    new_lat_rad = math.asin(
        math.sin(lat_rad) * math.cos(d) + math.cos(lat_rad) * math.sin(d) * math.cos(bearing_rad)
    )
    new_lon_rad = lon_rad + math.atan2(
        math.sin(bearing_rad) * math.sin(d) * math.cos(lat_rad),
        math.cos(d) - math.sin(lat_rad) * math.sin(new_lat_rad)
    )
    return math.degrees(new_lat_rad), math.degrees(new_lon_rad)


# --- Simulation Engines ---
def simulation_thread(stop_event):
    track = random.uniform(0, 359.9)
    loop_counter = 0
    while not stop_event.is_set():
        with STATE.lock:
            if GEOFENCE_BOUNDARY is not None:
                pos = gpd.GeoDataFrame(
                    geometry=[Point(STATE.vessel_state['lon'], STATE.vessel_state['lat'])],
                    crs="EPSG:4326"
                ).to_crs(GEOFENCE_BOUNDARY.crs)
                if not GEOFENCE_BOUNDARY.contains(pos).all():
                    track = (track + 180 + random.uniform(-45, 45)) % 360

            now = datetime.now(timezone.utc)
            s_kts = STATE.vessel_state['default_speed'] * random.uniform(0.9, 1.1)

            m_sec = s_kts * 0.514444
            if s_kts > 0:
                track = (track + random.uniform(-1, 1)) % 360
            n_lat, n_lon = calculate_destination(
                STATE.vessel_state['lat'], STATE.vessel_state['lon'], track, m_sec * 0.1
            )
            depth = round(random.uniform(180, 450), 1)

            STATE.vessel_state.update({
                'lat': n_lat, 'lon': n_lon, 'sog_knots': s_kts, 'track': track, 'heading': track,
                'seafloor_depth': depth, 'pitch': random.uniform(-2, 2),
                'roll': random.uniform(-4, 4), 'heave': random.uniform(-0.5, 0.5)
            })

            if loop_counter % 10 == 0:
                STATE.track_history.append((n_lat, n_lon, track))
                # Simple virtual area swept increment
                STATE.vessel_state['area_swept_kpi'] += (m_sec * 15.0) / 10000.0

            # Generate NMEA sentences
            sentences_log = []
            for h, fn in GENERATOR_FUNCTIONS.items():
                res = fn(STATE.vessel_state, now)
                STATE.latest_sentences[h] = res
                if isinstance(res, list):
                    sentences_log.extend(res)
                else:
                    sentences_log.append(res)

            # Route NMEA string to the Tkinter Live NMEA Console
            if STATE.app and sentences_log:
                STATE.app.log_vessel_nmea("".join(sentences_log))

            # Forward to active broadcast ports
            for device_name, info in STATE.active_ports.items():
                sentences_for_device = []
                headers = DEVICE_GROUPS.get(device_name, [])
                for header in headers:
                    latest_data = STATE.latest_sentences.get(header)
                    if latest_data:
                        if isinstance(latest_data, list):
                            sentences_for_device.extend(latest_data)
                        else:
                            sentences_for_device.append(latest_data)
                full_data = "".join(sentences_for_device)

        loop_counter += 1
        time.sleep(0.1)


def file_replay_thread(filename, stop_event):
    if not HAS_REPLAY_GIS:
        return
    try:
        df = pd.read_parquet(filename)
        nmea_df = df[df['data_type'] == 'nmea_sentences'].copy()
        timestamp_col = next(
            (col for col in ['survey_computer_recorded_at', 'timestamp', 'recorded_at', 'datetime']
             if col in nmea_df.columns), None
        )
        if timestamp_col is None:
            return
        nmea_df['timestamp'] = pd.to_datetime(nmea_df[timestamp_col])
        nmea_df = nmea_df.sort_values(by='timestamp').reset_index()
        loop_counter = 0
        for i, row in nmea_df.iterrows():
            if stop_event.is_set():
                break
            sentence = row['data_sentence']
            if not isinstance(sentence, str) or not sentence.startswith(('$', '@')):
                continue
            parts = sentence.split(',')
            header_part = parts[0][1:]
            header = f"${header_part}" if header_part.startswith(('GP', 'SD', 'II', 'WI')) else f"{parts[0]}"
            if len(parts) > 1 and "GP" in parts[1]:
                header = f"{parts[0]},{parts[1]}"
            with STATE.lock:
                formatted_sentence = sentence.strip() + "\r\n"
                STATE.latest_sentences[header] = formatted_sentence

                if STATE.app:
                    STATE.app.log_vessel_nmea(formatted_sentence)

                if header == "$GPRMC":
                    try:
                        lat_v, lat_d, lon_v, lon_d, sog, trk = parts[3:9]
                        lat = (int(lat_v[:2]) + float(lat_v[2:]) / 60) * (-1 if lat_d == 'S' else 1)
                        lon = (int(lon_v[:3]) + float(lon_v[3:]) / 60) * (-1 if lon_d == 'W' else 1)
                        STATE.vessel_state.update({
                            "lat": lat, "lon": lon, "sog_knots": float(sog), "track": float(trk),
                            "heading": float(trk)
                        })
                        if loop_counter % 10 == 0:
                            STATE.track_history.append((lat, lon, float(trk)))
                    except (ValueError, IndexError):
                        pass
            if i + 1 < len(nmea_df):
                delay = (nmea_df.loc[i + 1, 'timestamp'] - row['timestamp']).total_seconds()
                time.sleep(max(0, min(delay, 5)))
            loop_counter += 1
    except Exception:
        pass
    finally:
        with STATE.lock:
            STATE.current_mode = "Idle"
            STATE.data_source_thread = None


# --- Server Client Handlers ---
def tcp_client_handler(connection, data_keys, hz, stop_event):
    sleep_time = 1.0 / hz
    last_sent = {key: "" for key in data_keys}
    try:
        while not stop_event.is_set():
            cycle_start = time.time()
            to_send = ""
            with STATE.lock:
                for key in data_keys:
                    new = STATE.latest_sentences.get(key)
                    if new and new != last_sent[key]:
                        to_send += "".join(new) if isinstance(new, list) else new
                        last_sent[key] = new

            if to_send:
                connection.sendall(to_send.encode('ascii'))

            elapsed = time.time() - cycle_start
            time.sleep(max(0, sleep_time - elapsed))
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        connection.close()


def serial_client_handler(connection, data_keys, hz, baud, stop_event):
    sleep_time = 1.0 / hz
    baud_chars_per_sec = baud / 10.0
    chunk_size = 5
    delay_per_chunk = chunk_size / baud_chars_per_sec
    last_sent = {key: "" for key in data_keys}
    try:
        while not stop_event.is_set():
            cycle_start = time.time()
            to_send = ""
            with STATE.lock:
                for key in data_keys:
                    new = STATE.latest_sentences.get(key)
                    if new and new != last_sent[key]:
                        to_send += "".join(new) if isinstance(new, list) else new
                        last_sent[key] = new

            if to_send:
                data_bytes = to_send.encode('ascii')
                for i in range(0, len(data_bytes), chunk_size):
                    if stop_event.is_set():
                        break
                    connection.sendall(data_bytes[i:i + chunk_size])
                    time.sleep(delay_per_chunk)

            elapsed = time.time() - cycle_start
            time.sleep(max(0, sleep_time - elapsed))
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        connection.close()


def tcp_server_loop(host, port, data_keys, protocol, hz, baud, stop_event):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(1)
    try:
        sock.bind((host, port))
        sock.listen()
        while not stop_event.is_set():
            try:
                conn, _ = sock.accept()
                if protocol == "Serial":
                    h = threading.Thread(
                        target=serial_client_handler,
                        args=(conn, data_keys, hz, baud, stop_event),
                        daemon=True
                    )
                else:
                    h = threading.Thread(
                        target=tcp_client_handler,
                        args=(conn, data_keys, hz, stop_event),
                        daemon=True
                    )
                h.start()
            except socket.timeout:
                continue
    finally:
        sock.close()


def udp_broadcast_loop(port, data_keys, hz, stop_event):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sleep_time = 1.0 / hz
    last_sent = {key: "" for key in data_keys}
    try:
        while not stop_event.is_set():
            cycle_start = time.time()
            to_send = ""
            with STATE.lock:
                for key in data_keys:
                    new = STATE.latest_sentences.get(key)
                    if new and new != last_sent[key]:
                        to_send += "".join(new) if isinstance(new, list) else new
                        last_sent[key] = new

            if to_send:
                sock.sendto(to_send.encode('ascii'), ('<broadcast>', port))

            elapsed = time.time() - cycle_start
            time.sleep(max(0, sleep_time - elapsed))
    finally:
        sock.close()


def add_port_logic(port, dev_name, protocol="TCP", hz=1, baud=4800):
    sentences = DEVICE_GROUPS.get(dev_name)
    if not sentences or dev_name in STATE.active_ports or any(
            p.get('port') == port for p in STATE.active_ports.values()):
        return False, "Device active or port in use", None

    stop_ev = threading.Event()
    if protocol == "UDP":
        thread = threading.Thread(
            target=udp_broadcast_loop, args=(port, sentences, hz, stop_ev), daemon=True,
            name=str(port)
        )
    else:
        thread = threading.Thread(
            target=tcp_server_loop,
            args=('127.0.0.1', port, sentences, protocol, hz, baud, stop_ev), daemon=True,
            name=str(port)
        )

    STATE.server_threads[port], STATE.stop_events[port] = thread, stop_ev
    STATE.active_ports[dev_name] = {
        'port': port, 'protocol': protocol, 'hz': hz, 'baud': baud
    }
    return True, f"Port configured for {dev_name} via {protocol}", thread


# =====================================================================
# --- DATABASE SETTINGS AND CONFIGURATION PERSISTENCE ---
# =====================================================================

class ConfigDB:
    """Lightweight SQLite helper to persist simulator configuration."""
    def __init__(self, db_path="simulator_config.db"):
        self.db_path = db_path
        self.init_db()

    def get_connection(self):
        return sqlite3.connect(self.db_path)

    def init_db(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # Table for settings (e.g., server_ip, vessel simulator options)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            """)
            # Table for TCP to COM mappings
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tcp_com_mappings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tcp_port INTEGER NOT NULL,
                    com_port TEXT NOT NULL,
                    baud_rate INTEGER NOT NULL
                )
            """)
            # Table for TCP to UDP mappings
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tcp_udp_mappings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tcp_port INTEGER NOT NULL,
                    udp_ip TEXT NOT NULL,
                    udp_port INTEGER NOT NULL
                )
            """)
            # Table for local Vessel Simulator broadcast ports
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS vessel_sim_ports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_name TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    protocol TEXT NOT NULL,
                    hz INTEGER NOT NULL,
                    baud INTEGER NOT NULL
                )
            """)
            conn.commit()

    def get_setting(self, key, default=None):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
                row = cursor.fetchone()
                return row[0] if row else default
        except Exception:
            return default

    def set_setting(self, key, value):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
                conn.commit()
        except Exception as e:
            print(f"Error saving setting {key}: {e}")

    def get_tcp_com_mappings(self):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT id, tcp_port, com_port, baud_rate FROM tcp_com_mappings ORDER BY tcp_port"
                )
                return cursor.fetchall()
        except Exception:
            return []

    def add_tcp_com_mapping(self, tcp_port, com_port, baud_rate):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO tcp_com_mappings (tcp_port, com_port, baud_rate) VALUES (?, ?, ?)",
                    (tcp_port, com_port, baud_rate)
                )
                conn.commit()
                return cursor.lastrowid
        except Exception as e:
            print(f"Error adding TCP-COM mapping: {e}")
            return None

    def delete_tcp_com_mapping(self, mapping_id):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM tcp_com_mappings WHERE id = ?", (mapping_id,))
                conn.commit()
        except Exception as e:
            print(f"Error deleting TCP-COM mapping: {e}")

    def get_tcp_udp_mappings(self):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT id, tcp_port, udp_ip, udp_port FROM tcp_udp_mappings ORDER BY tcp_port"
                )
                return cursor.fetchall()
        except Exception:
            return []

    def add_tcp_udp_mapping(self, tcp_port, udp_ip, udp_port):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO tcp_udp_mappings (tcp_port, udp_ip, udp_port) VALUES (?, ?, ?)",
                    (tcp_port, udp_ip, udp_port)
                )
                conn.commit()
                return cursor.lastrowid
        except Exception as e:
            print(f"Error adding TCP-UDP mapping: {e}")
            return None

    def delete_tcp_udp_mapping(self, mapping_id):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM tcp_udp_mappings WHERE id = ?", (mapping_id,))
                conn.commit()
        except Exception as e:
            print(f"Error deleting TCP-UDP mapping: {e}")

    def get_vessel_sim_ports(self):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT id, device_name, port, protocol, hz, baud FROM vessel_sim_ports"
                )
                return cursor.fetchall()
        except Exception:
            return []

    def add_vessel_sim_port(self, device_name, port, protocol, hz, baud):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                # Check for duplicate
                cursor.execute("SELECT id FROM vessel_sim_ports WHERE port = ?", (port,))
                if cursor.fetchone():
                    return None
                cursor.execute(
                    "INSERT INTO vessel_sim_ports (device_name, port, protocol, hz, baud) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (device_name, port, protocol, hz, baud)
                )
                conn.commit()
                return cursor.lastrowid
        except Exception as e:
            print(f"Error adding vessel sim port: {e}")
            return None

    def delete_vessel_sim_port(self, port):
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM vessel_sim_ports WHERE port = ?", (port,))
                conn.commit()
        except Exception as e:
            print(f"Error deleting vessel sim port: {e}")


# =====================================================================
# --- MAIN HARDWARE SIMULATOR DESKTOP APP CLASS ---
# =====================================================================

class HardwareSimulatorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("NWFSC Vessel Simulator")
        self.root.geometry("850x850")

        # Initialize SQLite configuration DB
        self.db = ConfigDB()

        # Hook global shared state app reference for live NMEA console piping
        STATE.app = self

        # Add the window icon (favicon)
        icon_path = resource_path("serial_port.ico")
        if os.path.exists(icon_path):
            self.root.iconbitmap(icon_path)

        # Reader devices (outbound)
        self.devices = [
            "Marel M1100 - Large",
            "Marel M1100 - Small",
            "Scantrol FM-100",
            "Zebra Barcode Gun",
            "IchthyStick v3",
        ]

        # Listener devices (inbound printers)
        self.printers = ["Zebra Printer 1", "Zebra Printer 2"]

        self.port_vars = {}
        self.baud_vars = {}
        self.value_vars = {}

        # Listener thread states for Zebra Printers
        self.printer_threads = {}
        self.printer_running = {}
        self.printer_previews = {}

        # Telemetry threads and states
        self.telemetry_threads = {}
        self.telemetry_running = {}
        self.telemetry_indicators = {}

        # Vessel Simulator Settings & Variables
        self.vessel_speed_var = tk.DoubleVar(value=10.0)
        self.vessel_breadcrumbs_var = tk.BooleanVar(value=True)
        self.vessel_map_zoom_var = tk.DoubleVar(value=5000.0)  # pixels per degree
        self.vessel_file_tree = {}

        self.server_ip_var = tk.StringVar(value=self.db.get_setting("server_ip", "161.55.52.50"))

        self.create_widgets()

        # Load existing configuration and initialize lists
        self.refresh_telemetry_mappings_ui()
        self.populate_vessel_sim_files_tree()
        self.load_vessel_sim_config()

        # Run initial port refresh to log OS-detected COM ports
        self.refresh_ports()

        # Run periodic vessel simulator status and map redrawing loops
        self.poll_vessel_simulator_state()

        # Clean shutdown on window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def get_available_ports(self):
        """Returns a list of available COM ports, including known virtual ports."""
        detected_ports = [port.device for port in serial.tools.list_ports.comports()]
        virtual_ports = [f"COM{i}" for i in range(100, 126)] + [f"COM{i}" for i in range(200, 226)]
        all_ports = detected_ports + [p for p in virtual_ports if p not in detected_ports]
        return all_ports

    def refresh_ports(self):
        """Refreshes the COM port dropdowns for all devices, printers, and mappings."""
        available_ports = self.get_available_ports()

        # Query active ports registered in the OS
        detected_ports = [port.device for port in serial.tools.list_ports.comports()]

        for device in self.devices + self.printers:
            if device in self.port_vars:
                self.port_vars[device]["values"] = available_ports

        if hasattr(self, 'new_com_port_entry'):
            self.new_com_port_entry["values"] = available_ports

        self.log_message("System COM ports refreshed.")
        self.log_message(f"Detected physical/active COM ports in OS: {detected_ports}")

    def log_message(self, message):
        """Appends a timestamped message to the terminal log window safely from any thread."""
        def _insert():
            timestamp = datetime.now().strftime("%H:%M:%S")
            self.log_text.config(state=tk.NORMAL)
            self.log_text.insert(tk.END, f"[{timestamp}] {message}\n")
            self.log_text.see(tk.END)  # Auto-scroll to bottom
            self.log_text.config(state=tk.DISABLED)

        try:
            self.root.after(0, _insert)
        except Exception:
            pass

    def clear_log(self):
        """Clears the terminal log window."""
        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete(1.0, tk.END)
        self.log_text.config(state=tk.DISABLED)

    def create_widgets(self):
        # Top Container
        main_frame = tk.Frame(self.root)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Create notebook for tabbed navigation
        self.notebook = ttk.Notebook(main_frame)
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=(10, 5))

        # --- TAB 1: DEVICE SIMULATORS & PRINTERS ---
        self.simulators_tab = tk.Frame(self.notebook)
        self.notebook.add(self.simulators_tab, text="Simulated Devices")

        # Header inside devices tab
        header_frame = tk.Frame(self.simulators_tab)
        header_frame.pack(fill=tk.X, pady=(10, 5), padx=10)

        tk.Label(
            header_frame, text="Device", width=20, anchor="w", font=("Arial", 10, "bold")
        ).pack(side=tk.LEFT)
        tk.Label(
            header_frame, text="COM Port", width=12, anchor="w", font=("Arial", 10, "bold")
        ).pack(side=tk.LEFT)
        tk.Label(header_frame, text="Baud", width=10, anchor="w", font=("Arial", 10, "bold")).pack(
            side=tk.LEFT
        )
        tk.Label(
            header_frame, text="Value / Control", width=20, anchor="w", font=("Arial", 10, "bold")
        ).pack(side=tk.LEFT)

        tk.Button(header_frame, text="Refresh Ports", command=self.refresh_ports).pack(
            side=tk.RIGHT
        )

        available_ports = self.get_available_ports()
        baud_rates = ["4800", "9600", "19200", "38400", "115200"]

        # Device rows
        for i, device in enumerate(self.devices):
            row_frame = tk.Frame(self.simulators_tab)
            row_frame.pack(fill=tk.X, pady=3, padx=10)

            tk.Label(row_frame, text=device, width=20, anchor="w").pack(side=tk.LEFT)

            port_cb = ttk.Combobox(row_frame, values=available_ports, width=10)
            port_cb.set(f"COM{201 + i}")
            port_cb.pack(side=tk.LEFT, padx=(0, 10))
            self.port_vars[device] = port_cb

            baud_cb = ttk.Combobox(row_frame, values=baud_rates, width=8)
            baud_cb.set("4800" if "Marel" in device else "9600")
            baud_cb.pack(side=tk.LEFT, padx=(0, 10))
            self.baud_vars[device] = baud_cb

            val_entry = tk.Entry(row_frame, width=20)
            val_entry.pack(side=tk.LEFT, padx=(0, 15))
            self.value_vars[device] = val_entry

            tk.Button(
                row_frame,
                text="Send",
                width=10,
                command=lambda d=device: self.send_data(d),
            ).pack(side=tk.LEFT)

        # Separator Line
        ttk.Separator(self.simulators_tab, orient="horizontal").pack(fill=tk.X, pady=10, padx=10)

        # Zebra Printer Receivers (Listeners) placed right below devices
        printers_frame = tk.LabelFrame(
            self.simulators_tab, text="Zebra Printer Receivers (Listeners)", padx=5, pady=5
        )
        printers_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(5, 10))

        preview_container = tk.Frame(printers_frame)
        preview_container.pack(fill=tk.BOTH, expand=True, pady=5)

        for i, printer in enumerate(self.printers):
            p_col = tk.Frame(preview_container)
            p_col.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5)

            # Controls row
            ctrl_row = tk.Frame(p_col)
            ctrl_row.pack(fill=tk.X, pady=2)

            tk.Label(ctrl_row, text=printer, font=("Arial", 9, "bold")).pack(anchor="w")

            port_cb = ttk.Combobox(ctrl_row, values=available_ports, width=8)
            port_cb.set(f"COM{210 + i}")
            port_cb.pack(side=tk.LEFT, padx=(0, 5))
            self.port_vars[printer] = port_cb

            baud_cb = ttk.Combobox(ctrl_row, values=baud_rates, width=7)
            baud_cb.set("9600")
            baud_cb.pack(side=tk.LEFT, padx=(0, 5))
            self.baud_vars[printer] = baud_cb

            toggle_btn = tk.Button(ctrl_row, text="Listen", width=8, bg="lightgrey")
            toggle_btn.config(
                command=lambda p=printer, b=toggle_btn: self.toggle_printer_listener(p, b)
            )
            toggle_btn.pack(side=tk.LEFT)

            # Rendered Tag Box (Simulated Zebra Label Output)
            lbl_frame = tk.Frame(p_col, bd=2, relief=tk.SOLID, bg="white", height=120)
            lbl_frame.pack(fill=tk.BOTH, expand=True, pady=5)
            lbl_frame.pack_propagate(False)

            preview_text = tk.Text(
                lbl_frame, bg="white", fg="black", font=("Courier", 8), state=tk.DISABLED, bd=0
            )
            preview_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
            self.printer_previews[printer] = preview_text

            # Initial Placeholder Text inside Label Preview
            self.render_preview(printer, ["=== READY FOR PRINT JOB ==="])

        # --- TAB 2: TELEMETRY FORWARDING ---
        self.telemetry_tab = tk.Frame(self.notebook)
        self.notebook.add(self.telemetry_tab, text="Telemetry Forwarding")

        # 1. Vessel Server Config Frame
        server_frame = tk.LabelFrame(self.telemetry_tab, text="Vessel Server Config", padx=10, pady=5)
        server_frame.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(server_frame, text="Vessel Server IP Address:").pack(side=tk.LEFT, padx=(0, 10))
        server_ip_entry = tk.Entry(server_frame, textvariable=self.server_ip_var, width=20)
        server_ip_entry.pack(side=tk.LEFT, padx=(0, 10))

        tk.Button(
            server_frame, text="Save Config", command=self.save_server_ip, bg="lightgrey"
        ).pack(side=tk.LEFT, padx=(0, 5))
        tk.Button(
            server_frame, text="Test Connection", command=self.test_ip_connection, bg="lightgrey"
        ).pack(side=tk.LEFT)

        # Column container for mappings
        col_container = tk.Frame(self.telemetry_tab)
        col_container.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        col_container.columnconfigure(0, weight=1)
        col_container.columnconfigure(1, weight=1)
        col_container.rowconfigure(0, weight=1)

        # Left Column - TCP to COM
        left_col = tk.LabelFrame(col_container, text="TCP to Virtual COM Bridges", padx=5, pady=5)
        left_col.grid(row=0, column=0, sticky="nsew", padx=(0, 5))

        # Add Row for TCP to COM
        com_add_frame = tk.Frame(left_col)
        com_add_frame.pack(fill=tk.X, pady=5)

        tk.Label(com_add_frame, text="TCP:").pack(side=tk.LEFT, padx=1)
        self.new_tcp_port_com_var = tk.StringVar()
        tk.Entry(com_add_frame, textvariable=self.new_tcp_port_com_var, width=5).pack(
            side=tk.LEFT, padx=2
        )

        tk.Label(com_add_frame, text="COM:").pack(side=tk.LEFT, padx=1)
        self.new_com_port_entry = ttk.Combobox(com_add_frame, values=available_ports, width=8)
        self.new_com_port_entry.set("COM220")
        self.new_com_port_entry.pack(side=tk.LEFT, padx=2)

        tk.Label(com_add_frame, text="Baud:").pack(side=tk.LEFT, padx=1)
        self.new_baud_com_var = tk.StringVar(value="9600")
        ttk.Combobox(
            com_add_frame, textvariable=self.new_baud_com_var, values=baud_rates, width=6
        ).pack(side=tk.LEFT, padx=2)

        tk.Button(
            com_add_frame, text="Add", command=self.add_tcp_com_mapping_ui, width=5, bg="lightgrey"
        ).pack(side=tk.LEFT, padx=3)

        # Mappings list inner frame for TCP to COM
        self.com_list_inner = tk.Frame(left_col)
        self.com_list_inner.pack(fill=tk.BOTH, expand=True, pady=5)

        # Live COM stream console at the bottom
        com_console_frame = tk.LabelFrame(left_col, text="Live COM Stream Monitor", padx=5, pady=5)
        com_console_frame.pack(fill=tk.BOTH, expand=False, side=tk.BOTTOM, pady=5)

        btn_row_com = tk.Frame(com_console_frame)
        btn_row_com.pack(fill=tk.X, side=tk.BOTTOM)
        tk.Button(
            btn_row_com, text="Clear COM Console", command=self.clear_com_console, bg="lightgrey", font=("Arial", 8)
        ).pack(side=tk.RIGHT, pady=(3, 0))

        self.com_stream_text = tk.Text(
            com_console_frame,
            height=6,
            width=30,
            state=tk.DISABLED,
            bg="black",
            fg="lightgreen",
            font=("Consolas", 9),
        )
        com_scroll = tk.Scrollbar(com_console_frame, command=self.com_stream_text.yview)
        self.com_stream_text.configure(yscrollcommand=com_scroll.set)
        self.com_stream_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        com_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        # Right Column - TCP to UDP
        right_col = tk.LabelFrame(col_container, text="TCP to UDP Bridges (Coalescer)", padx=5, pady=5)
        right_col.grid(row=0, column=1, sticky="nsew", padx=(5, 0))

        # Add Row for TCP to UDP
        udp_add_frame = tk.Frame(right_col)
        udp_add_frame.pack(fill=tk.X, pady=5)

        tk.Label(udp_add_frame, text="TCP:").pack(side=tk.LEFT, padx=1)
        self.new_tcp_port_udp_var = tk.StringVar()
        tk.Entry(udp_add_frame, textvariable=self.new_tcp_port_udp_var, width=5).pack(
            side=tk.LEFT, padx=2
        )

        tk.Label(udp_add_frame, text="IP:").pack(side=tk.LEFT, padx=1)
        self.new_udp_ip_var = tk.StringVar(value="127.0.0.1")
        tk.Entry(udp_add_frame, textvariable=self.new_udp_ip_var, width=11).pack(
            side=tk.LEFT, padx=2
        )

        tk.Label(udp_add_frame, text="UDP:").pack(side=tk.LEFT, padx=1)
        self.new_udp_port_var = tk.StringVar(value="10110")
        tk.Entry(udp_add_frame, textvariable=self.new_udp_port_var, width=6).pack(
            side=tk.LEFT, padx=2
        )

        tk.Button(
            udp_add_frame, text="Add", command=self.add_tcp_udp_mapping_ui, width=5, bg="lightgrey"
        ).pack(side=tk.LEFT, padx=3)

        # Mappings list inner frame for TCP to UDP
        self.udp_list_inner = tk.Frame(right_col)
        self.udp_list_inner.pack(fill=tk.BOTH, expand=True, pady=5)

        # Live UDP stream console at the bottom
        udp_console_frame = tk.LabelFrame(right_col, text="Live UDP Stream Monitor", padx=5, pady=5)
        udp_console_frame.pack(fill=tk.BOTH, expand=False, side=tk.BOTTOM, pady=5)

        btn_row_udp = tk.Frame(udp_console_frame)
        btn_row_udp.pack(fill=tk.X, side=tk.BOTTOM)
        tk.Button(
            btn_row_udp, text="Clear UDP Console", command=self.clear_udp_console, bg="lightgrey", font=("Arial", 8)
        ).pack(side=tk.RIGHT, pady=(3, 0))

        self.udp_stream_text = tk.Text(
            udp_console_frame,
            height=6,
            width=30,
            state=tk.DISABLED,
            bg="black",
            fg="lightgreen",
            font=("Consolas", 9),
        )
        udp_scroll = tk.Scrollbar(udp_console_frame, command=self.udp_stream_text.yview)
        self.udp_stream_text.configure(yscrollcommand=udp_scroll.set)
        self.udp_stream_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        udp_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        # --- TAB 3: LOCAL VESSEL SIMULATOR (WITH NATIVE MAP) ---
        self.vessel_tab = tk.Frame(self.notebook)
        self.notebook.add(self.vessel_tab, text="Vessel Simulator")

        # Top Control Panel
        vessel_ctrl_frame = tk.LabelFrame(self.vessel_tab, text="Simulation Controls", padx=10, pady=5)
        vessel_ctrl_frame.pack(fill=tk.X, padx=10, pady=5)

        # Control Row 1: Source & Start/Stop
        ctrl_r1 = tk.Frame(vessel_ctrl_frame)
        ctrl_r1.pack(fill=tk.X, pady=3)

        tk.Label(ctrl_r1, text="Source Mode:").pack(side=tk.LEFT, padx=(0, 5))
        self.vessel_source_cb = ttk.Combobox(ctrl_r1, values=["Simulation", "File Replay"], width=12, state="readonly")
        self.vessel_source_cb.set("Simulation")
        self.vessel_source_cb.pack(side=tk.LEFT, padx=(0, 10))
        self.vessel_source_cb.bind("<<ComboboxSelected>>", self.on_vessel_source_mode_changed)

        self.vessel_start_btn = tk.Button(
            ctrl_r1, text="Start Simulator", command=self.start_vessel_simulation_ui, bg="chartreuse3", fg="white", width=12
        )
        self.vessel_start_btn.pack(side=tk.LEFT, padx=(0, 5))

        self.vessel_stop_btn = tk.Button(
            ctrl_r1, text="Stop Simulator", command=self.stop_vessel_simulation_ui, bg="firebrick2", fg="white", width=12, state=tk.DISABLED
        )
        self.vessel_stop_btn.pack(side=tk.LEFT, padx=(0, 10))

        # Control Row 2: Speed Slider and Breadcrumbs and Zoom Scale
        ctrl_r2 = tk.Frame(vessel_ctrl_frame)
        ctrl_r2.pack(fill=tk.X, pady=5)

        tk.Label(ctrl_r2, text="Speed:").pack(side=tk.LEFT, padx=(0, 2))
        self.vessel_speed_scale = tk.Scale(
            ctrl_r2, from_=0.0, to=25.0, resolution=0.1, orient=tk.HORIZONTAL, showvalue=False,
            variable=self.vessel_speed_var, command=self.update_vessel_speed_from_slider, width=8
        )
        self.vessel_speed_scale.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))

        self.vessel_speed_spin = tk.Spinbox(
            ctrl_r2, from_=0.0, to=25.0, increment=0.1, textvariable=self.vessel_speed_var,
            width=4, command=self.update_vessel_speed_from_spin
        )
        self.vessel_speed_spin.pack(side=tk.LEFT, padx=(0, 10))
        self.vessel_speed_spin.bind("<Return>", lambda e: self.update_vessel_speed_from_spin())

        # Map Zoom Control
        tk.Label(ctrl_r2, text="Map Zoom:").pack(side=tk.LEFT, padx=(0, 2))
        self.vessel_zoom_scale = tk.Scale(
            ctrl_r2, from_=1000.0, to=30000.0, resolution=500.0, orient=tk.HORIZONTAL, showvalue=False,
            variable=self.vessel_map_zoom_var, width=8
        )
        self.vessel_zoom_scale.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 10))

        self.vessel_bread_chk = tk.Checkbutton(
            ctrl_r2, text="Trail", variable=self.vessel_breadcrumbs_var,
            command=self.toggle_vessel_breadcrumbs
        )
        self.vessel_bread_chk.pack(side=tk.LEFT)

        # Control Row 3: Parquet File Replay Config (Hidden by default)
        self.vessel_replay_options_frame = tk.Frame(vessel_ctrl_frame)

        tk.Label(self.vessel_replay_options_frame, text="Year:").pack(side=tk.LEFT, padx=(0, 2))
        self.vessel_year_cb = ttk.Combobox(self.vessel_replay_options_frame, width=6, state="readonly")
        self.vessel_year_cb.pack(side=tk.LEFT, padx=(0, 8))
        self.vessel_year_cb.bind("<<ComboboxSelected>>", self.on_vessel_year_changed)

        tk.Label(self.vessel_replay_options_frame, text="Vessel:").pack(side=tk.LEFT, padx=(0, 2))
        self.vessel_vessel_cb = ttk.Combobox(self.vessel_replay_options_frame, width=12, state="readonly")
        self.vessel_vessel_cb.pack(side=tk.LEFT, padx=(0, 8))
        self.vessel_vessel_cb.bind("<<ComboboxSelected>>", self.on_vessel_vessel_changed)

        tk.Label(self.vessel_replay_options_frame, text="Parquet File:").pack(side=tk.LEFT, padx=(0, 2))
        self.vessel_file_cb = ttk.Combobox(self.vessel_replay_options_frame, width=25, state="readonly")
        self.vessel_file_cb.pack(side=tk.LEFT)

        # Sub Layout: Left (Controls/Telemetry), Middle (Native Map), Right (Ports/Sentences)
        vessel_layout_container = tk.Frame(self.vessel_tab)
        vessel_layout_container.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        vessel_layout_container.columnconfigure(0, weight=3)  # Readout Left
        vessel_layout_container.columnconfigure(1, weight=4)  # Map Middle
        vessel_layout_container.columnconfigure(2, weight=4)  # Ports/Console Right
        vessel_layout_container.rowconfigure(0, weight=1)

        # COLUMN 1: Telemetry Readout
        v_readout_col = tk.LabelFrame(vessel_layout_container, text="Vessel Telemetry", padx=5, pady=5)
        v_readout_col.grid(row=0, column=0, sticky="nsew", padx=(0, 3))

        self.vessel_status_label = tk.Label(v_readout_col, text="Status: Idle", font=("Arial", 10, "bold"), anchor="w")
        self.vessel_status_label.pack(fill=tk.X, pady=(0, 5))

        self.vessel_info_label = tk.Label(
            v_readout_col, text="Lat: 0.000000\nLon: 0.000000\nSpeed: 0.00 kts\nDepth: 0.0 m\nArea Swept: 0.00 ha",
            font=("Consolas", 9), justify=tk.LEFT, anchor="w"
        )
        self.vessel_info_label.pack(fill=tk.BOTH, expand=True)

        # COLUMN 2: Native Map Canvas
        v_map_col = tk.LabelFrame(vessel_layout_container, text="GIS Tracking Map", padx=5, pady=5)
        v_map_col.grid(row=0, column=1, sticky="nsew", padx=3)

        self.map_canvas = tk.Canvas(v_map_col, bg="#001423", bd=1, relief=tk.SOLID)
        self.map_canvas.pack(fill=tk.BOTH, expand=True)

        # COLUMN 3: NMEA Ports & Live simulated sentences stream terminal
        v_ports_col = tk.LabelFrame(vessel_layout_container, text="Ports & NMEA Stream", padx=5, pady=5)
        v_ports_col.grid(row=0, column=2, sticky="nsew", padx=(3, 0))

        # Port configuration frame
        vport_add_frame = tk.Frame(v_ports_col)
        vport_add_frame.pack(fill=tk.X, pady=3)

        tk.Label(vport_add_frame, text="Dev:").pack(side=tk.LEFT)
        self.vessel_device_cb = ttk.Combobox(vport_add_frame, values=list(DEVICE_GROUPS.keys()), width=8, state="readonly")
        if list(DEVICE_GROUPS.keys()):
            self.vessel_device_cb.set(list(DEVICE_GROUPS.keys())[0])
        self.vessel_device_cb.pack(side=tk.LEFT, padx=1)

        tk.Label(vport_add_frame, text="Port:").pack(side=tk.LEFT)
        vessel_ports_list = [f"COM{i}" for i in range(3, 21)]
        self.vessel_port_cb = ttk.Combobox(vport_add_frame, values=vessel_ports_list, width=5)
        self.vessel_port_cb.set("COM13")
        self.vessel_port_cb.pack(side=tk.LEFT, padx=1)

        tk.Label(vport_add_frame, text="P:").pack(side=tk.LEFT)
        self.vessel_protocol_cb = ttk.Combobox(vport_add_frame, values=["TCP", "UDP", "Serial"], width=4, state="readonly")
        self.vessel_protocol_cb.set("TCP")
        self.vessel_protocol_cb.pack(side=tk.LEFT, padx=1)

        tk.Button(
            vport_add_frame, text="+", command=self.add_vessel_sim_port_ui, width=2, bg="lightgrey", font=("Arial", 8, "bold")
        ).pack(side=tk.LEFT, padx=1)

        # Simple micro comboboxes for optional parameters
        vport_sub_frame = tk.Frame(v_ports_col)
        vport_sub_frame.pack(fill=tk.X, pady=2)

        tk.Label(vport_sub_frame, text="Hz:").pack(side=tk.LEFT)
        self.vessel_hz_cb = ttk.Combobox(vport_sub_frame, values=["1 Hz", "10 Hz"], width=4, state="readonly")
        self.vessel_hz_cb.set("1 Hz")
        self.vessel_hz_cb.pack(side=tk.LEFT, padx=2)

        tk.Label(vport_sub_frame, text="Baud:").pack(side=tk.LEFT)
        self.vessel_baud_cb = ttk.Combobox(vport_sub_frame, values=baud_rates, width=5)
        self.vessel_baud_cb.set("4800")
        self.vessel_baud_cb.pack(side=tk.LEFT, padx=2)

        # Dynamic ports list
        self.vessel_ports_list_inner = tk.Frame(v_ports_col, height=60)
        self.vessel_ports_list_inner.pack(fill=tk.BOTH, expand=False, pady=3)

        # Live Simulated NMEA Sentences Console at the bottom
        nmea_frame = tk.LabelFrame(v_ports_col, text="Live Simulated NMEA stream", padx=5, pady=5)
        nmea_frame.pack(fill=tk.BOTH, expand=True, pady=(3, 0))

        self.vessel_nmea_text = tk.Text(
            nmea_frame,
            height=6,
            width=25,
            state=tk.DISABLED,
            bg="black",
            fg="lightgreen",
            font=("Consolas", 8),
        )
        nmea_scroll = tk.Scrollbar(nmea_frame, command=self.vessel_nmea_text.yview)
        self.vessel_nmea_text.configure(yscrollcommand=nmea_scroll.set)
        self.vessel_nmea_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        nmea_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        btn_row_nmea = tk.Frame(nmea_frame)
        btn_row_nmea.pack(fill=tk.X, side=tk.BOTTOM)
        tk.Button(
            btn_row_nmea, text="Clear NMEA", command=self.clear_vessel_nmea_console, bg="lightgrey", font=("Arial", 7)
        ).pack(side=tk.RIGHT, pady=(1, 0))


        # --- SHARED BOTTOM LOGGER WINDOW (Always Visible) ---
        log_frame = tk.LabelFrame(main_frame, text="Transmission Log", padx=5, pady=5)
        log_frame.pack(fill=tk.X, pady=(5, 5), padx=10)

        self.log_text = tk.Text(
            log_frame,
            height=10,
            state=tk.DISABLED,
            bg="black",
            fg="lightgreen",
            font=("Consolas", 9),
        )
        scrollbar = tk.Scrollbar(log_frame, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scrollbar.set)

        self.log_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Footer
        footer_frame = tk.Frame(main_frame)
        footer_frame.pack(fill=tk.X, padx=10, pady=(0, 10))
        tk.Button(footer_frame, text="Clear Log", command=self.clear_log, width=10).pack(
            side=tk.RIGHT
        )

        self.log_message("Application started. Ready to transmit & receive.")

    # --- PRINTER PREVIEW DRAWING ---

    def toggle_printer_listener(self, printer_name, button):
        """Starts or stops the background thread listening on the printer's serial port."""
        if self.printer_running.get(printer_name, False):
            self.printer_running[printer_name] = False
            button.config(text="Listen", bg="lightgrey")
            self.log_message(f"Stopped listener for {printer_name}.")
        else:
            raw_port = self.port_vars[printer_name].get().strip().upper()
            baud_rate = self.baud_vars[printer_name].get().strip()

            if not raw_port:
                messagebox.showwarning("Missing Port", f"Select a COM port for {printer_name}.")
                return

            if raw_port.isdigit():
                raw_port = f"COM{raw_port}"
                self.port_vars[printer_name].set(raw_port)

            port_path = f"\\\\.\\{raw_port}" if raw_port.startswith("COM") else raw_port

            self.printer_running[printer_name] = True
            t = threading.Thread(
                target=self.listen_on_port,
                args=(printer_name, port_path, int(baud_rate)),
                daemon=True,
            )
            self.printer_threads[printer_name] = t
            t.start()

            button.config(text="Listening...", bg="chartreuse3")
            self.log_message(f"Started listener for {printer_name} on {raw_port} @ {baud_rate}.")

    def listen_on_port(self, printer_name, port_path, baud_rate):
        """Continuously reads bytes from serial port in background and parses Zebra EPL commands."""
        buffer = bytearray()
        try:
            with serial.Serial(port_path, baudrate=baud_rate, timeout=1) as ser:
                while self.printer_running.get(printer_name, False):
                    data = ser.read(1024)
                    if data:
                        buffer.extend(data)
                        if b"P1" in buffer or b"\nP" in buffer:
                            raw_payload = buffer.decode("utf-8", errors="ignore")
                            buffer.clear()

                            parsed_lines = self.parse_epl2_payload(raw_payload)
                            self.root.after(0, self.render_preview, printer_name, parsed_lines)
                            self.root.after(
                                0,
                                self.log_message,
                                f"[{printer_name}] Received & printed label job ({len(parsed_lines)} fields parsed).",
                            )
                    time.sleep(0.05)
        except Exception as e:
            self.root.after(0, self.log_message, f"ERROR [{printer_name}]: {e}")
            self.root.after(0, self.reset_printer_button, printer_name)

    def reset_printer_button(self, printer_name):
        self.printer_running[printer_name] = False

    def parse_epl2_payload(self, raw_epl):
        display_lines = []
        lines = raw_epl.splitlines()

        for line in lines:
            line = line.strip()
            if line.startswith("A") and '"' in line:
                match = re.search(r'"([^"]*)"', line)
                if match:
                    display_lines.append(match.group(1))
            elif line.startswith("B") and '"' in line:
                match = re.search(r'"([^"]*)"', line)
                if match:
                    barcode_val = match.group(1)
                    display_lines.append("--------------------------")
                    display_lines.append(f"||| |||||| | ||||| ||||||\n    *{barcode_val}*")
                    display_lines.append("--------------------------")

        return display_lines if display_lines else ["<Empty or Raw EPL Received>"]

    def render_preview(self, printer_name, lines):
        widget = self.printer_previews[printer_name]
        widget.config(state=tk.NORMAL)
        widget.delete(1.0, tk.END)

        for line in lines:
            widget.insert(tk.END, f"{line}\n")

        widget.config(state=tk.DISABLED)

    # --- DEVICE TRANSMISSION LOGIC ---

    def format_sentence(self, device, value):
        try:
            if device in ["Marel M1100 - Large", "Marel M1100 - Small"]:
                weight = float(value)
                tare = 0.00
                sentence = f"{weight:>8.2f} kg{tare:>6.2f} kg\r\n"
                return sentence.encode("ascii")

            elif device == "Scantrol FM-100":
                val_float = float(value)
                val_str = f"{val_float:.1f}"
                padded_val = val_str.ljust(6)[:6]
                sentence = (" " * 32) + padded_val + "\r\n"
                return sentence.encode("ascii")

            elif device == "IchthyStick v3":
                val_float = float(value)
                val_str = f"{val_float:.1f}"
                padded_val = val_str.ljust(4)[:4]
                sentence = padded_val + "\r\n"
                return sentence.encode("ascii")

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

        if device != "Zebra Barcode Gun":
            try:
                val_float = float(value_str)
            except ValueError:
                messagebox.showwarning("Invalid Input", f"{device} requires a numeric value.")
                return

            if device == "Scantrol FM-100":
                val_float = round(val_float * 2.0) / 2.0
            else:
                val_float = round(val_float, 1)

            value_str = str(val_float)
            self.value_vars[device].delete(0, tk.END)
            self.value_vars[device].insert(0, value_str)

        if raw_port.isdigit():
            raw_port = f"COM{raw_port}"
            self.port_vars[device].set(raw_port)

        port_path = f"\\\\.\\{raw_port}" if raw_port.startswith("COM") else raw_port

        data_bytes = self.format_sentence(device, value_str)
        if not data_bytes:
            return

        try:
            with serial.Serial(
                port_path, baudrate=int(baud_rate), timeout=1, write_timeout=1
            ) as ser:
                ser.write(data_bytes)
                ser.flush()

            self.log_message(f"[{raw_port} @ {baud_rate}] {device} -> {repr(data_bytes)}")

        except serial.SerialTimeoutException:
            err_msg = f"Write timeout on {raw_port}. Receiving end may not be listening."
            self.log_message(f"ERROR: {err_msg}")
            messagebox.showerror("Serial Timeout", err_msg)
        except serial.SerialException as e:
            err_msg = f"Could not connect to {raw_port}."
            self.log_message(f"ERROR: {err_msg}")
            messagebox.showerror("Serial Error", f"{err_msg}\n\nDetails: {e}")
        except Exception as e:
            messagebox.showerror("Error", f"An unexpected error occurred:\n\n{e}")

    # --- TELEMETRY NETWORKING LOGIC ---

    def save_server_ip(self):
        server_ip = self.server_ip_var.get().strip()
        if not server_ip:
            messagebox.showwarning("Missing IP", "Please enter a valid Server IP Address.")
            return
        self.db.set_setting("server_ip", server_ip)
        self.log_message(f"Saved Vessel Server IP: {server_ip}")
        messagebox.showinfo("Config Saved", f"Vessel Server IP saved successfully:\n{server_ip}")

    def test_ip_connection(self):
        server_ip = self.server_ip_var.get().strip()
        if not server_ip:
            messagebox.showwarning("Missing IP", "Please specify an IP address first.")
            return

        self.log_message(f"Testing connection to {server_ip}...")

        def run_test():
            try:
                socket.gethostbyname(server_ip)
            except socket.gaierror:
                self.log_message(f"ERROR: Could not resolve hostname/IP: {server_ip}")
                self.root.after(
                    0, lambda: messagebox.showerror("Test Failed", f"Could not resolve host: {server_ip}")
                )
                return

            test_port = 22  # SSH default
            mappings = self.db.get_tcp_com_mappings() + self.db.get_tcp_udp_mappings()
            if mappings:
                test_port = mappings[0][1]  # Use first mapping's TCP port as target

            try:
                s = socket.create_connection((server_ip, test_port), timeout=2)
                s.close()
                msg = f"Connection to {server_ip}:{test_port} successful!"
                self.log_message(msg)
                self.root.after(0, lambda: messagebox.showinfo("Test Success", msg))
            except Exception as e:
                msg = (
                    f"Host {server_ip} is reachable (resolved), but test port {test_port} "
                    f"did not accept connection: {e}"
                )
                self.log_message(msg)
                self.root.after(0, lambda: messagebox.showinfo("Test Reachable", msg))

        threading.Thread(target=run_test, daemon=True).start()

    def toggle_telemetry_stream(self, type_, mapping_id):
        """Toggles the running state of a telemetry stream."""
        key = (type_, mapping_id)
        if self.telemetry_running.get(key, False):
            self.stop_telemetry_stream(type_, mapping_id)
        else:
            self.start_telemetry_stream(type_, mapping_id)

    def start_telemetry_stream(self, type_, mapping_id):
        key = (type_, mapping_id)
        self.telemetry_running[key] = True

        if type_ == "com":
            mappings = self.db.get_tcp_com_mappings()
            mapping = next((m for m in mappings if m[0] == mapping_id), None)
            if mapping:
                _, tcp_port, com_port, baud_rate = mapping
                t = threading.Thread(
                    target=self.run_tcp_com_bridge,
                    args=(mapping_id, tcp_port, com_port, baud_rate),
                    daemon=True
                )
                self.telemetry_threads[key] = t
                t.start()
        elif type_ == "udp":
            mappings = self.db.get_tcp_udp_mappings()
            mapping = next((m for m in mappings if m[0] == mapping_id), None)
            if mapping:
                _, tcp_port, udp_ip, udp_port = mapping
                t = threading.Thread(
                    target=self.run_tcp_udp_bridge,
                    args=(mapping_id, tcp_port, udp_ip, udp_port),
                    daemon=True
                )
                self.telemetry_threads[key] = t
                t.start()

        self.refresh_telemetry_mappings_ui()

    def stop_telemetry_stream(self, type_, mapping_id, update_ui=True):
        key = (type_, mapping_id)
        self.telemetry_running[key] = False
        self.update_telemetry_indicator(key, "grey")
        if update_ui:
            self.refresh_telemetry_mappings_ui()

    def update_telemetry_indicator(self, key, color_name):
        """Updates the color of a specific status indicator on the UI thread."""
        indicator_canvas = self.telemetry_indicators.get(key)
        if indicator_canvas:
            color_map = {
                "green": ("chartreuse3", "darkgreen"),
                "yellow": ("gold", "darkgoldenrod"),
                "red": ("firebrick2", "darkred"),
                "grey": ("grey", "darkgrey")
            }
            fill_color, outline_color = color_map.get(color_name, ("grey", "darkgrey"))
            try:
                items = indicator_canvas.find_all()
                if items:
                    indicator_canvas.itemconfig(items[0], fill=fill_color, outline=outline_color)
            except Exception:
                pass

    def log_com_stream(self, sentence_str):
        """Appends raw NMEA sentence to COM stream monitor text area thread-safely."""
        def _insert():
            self.com_stream_text.config(state=tk.NORMAL)
            self.com_stream_text.insert(tk.END, sentence_str)
            lines_str = self.com_stream_text.index('end-1c').split('.')[0]
            if lines_str:
                lines = int(lines_str)
                if lines > 200:
                    self.com_stream_text.delete("1.0", f"{lines - 200}.0")
            self.com_stream_text.see(tk.END)
            self.com_stream_text.config(state=tk.DISABLED)

        try:
            self.root.after(0, _insert)
        except Exception:
            pass

    def log_udp_stream(self, sentence_str):
        """Appends raw NMEA sentence to UDP stream monitor text area thread-safely."""
        def _insert():
            self.udp_stream_text.config(state=tk.NORMAL)
            self.udp_stream_text.insert(tk.END, sentence_str)
            lines_str = self.udp_stream_text.index('end-1c').split('.')[0]
            if lines_str:
                lines = int(lines_str)
                if lines > 200:
                    self.udp_stream_text.delete("1.0", f"{lines - 200}.0")
            self.udp_stream_text.see(tk.END)
            self.udp_stream_text.config(state=tk.DISABLED)

        try:
            self.root.after(0, _insert)
        except Exception:
            pass

    def clear_com_console(self):
        self.com_stream_text.config(state=tk.NORMAL)
        self.com_stream_text.delete(1.0, tk.END)
        self.com_stream_text.config(state=tk.DISABLED)

    def clear_udp_console(self):
        self.udp_stream_text.config(state=tk.NORMAL)
        self.udp_stream_text.delete(1.0, tk.END)
        self.udp_stream_text.config(state=tk.DISABLED)

    def run_tcp_com_bridge(self, mapping_id, tcp_port, com_port, baud_rate):
        """Thread worker for a single TCP-to-COM port bridge ('Always Current' mode)."""
        thread_name = f"[TCP:{tcp_port} -> {com_port}]"
        self.log_message(f"Starting 'Always Current' bridge {thread_name}...")

        stream_key = ("com", mapping_id)
        self.root.after(0, self.update_telemetry_indicator, stream_key, "yellow")

        ser = None
        sock = None
        keep_buffer_size = 1024
        poll_interval = 0.1

        try:
            # Open virtual COM Port
            try:
                port_path = com_port
                if sys.platform == "win32" and port_path.upper().startswith("COM"):
                    port_path = f"\\\\.\\{port_path.upper()}"
                elif port_path.isdigit():
                    port_path = f"\\\\.\\COM{port_path}"

                ser = serial.Serial(port_path, baud_rate, timeout=1, write_timeout=1)
                self.log_message(f"{thread_name} Successfully opened {com_port}")
            except serial.SerialException as e:
                self.log_message(f"ERROR: {thread_name} Could not open serial port {com_port}: {e}")
                self.root.after(0, self.update_telemetry_indicator, stream_key, "red")
                self.root.after(0, self.stop_telemetry_stream, "com", mapping_id, True)
                return

            # Main stream loop
            while self.telemetry_running.get(stream_key, False):
                server_ip = self.server_ip_var.get().strip()
                try:
                    self.log_message(f"{thread_name} Connecting to {server_ip}:{tcp_port}...")
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.settimeout(5)
                    sock.connect((server_ip, tcp_port))

                    self.log_message(f"{thread_name} Connected. Streaming to COM...")
                    self.root.after(0, self.update_telemetry_indicator, stream_key, "green")
                    sock.setblocking(False)

                    # Data Forwarding Loop
                    while self.telemetry_running.get(stream_key, False):
                        full_burst = b""
                        while self.telemetry_running.get(stream_key, False):
                            try:
                                chunk = sock.recv(4096)
                                if not chunk:
                                    self.log_message(f"{thread_name} Connection closed by server.")
                                    raise ConnectionResetError
                                full_burst += chunk
                            except (BlockingIOError, socket.timeout, socket.error):
                                break

                        if full_burst:
                            latest_data = full_burst[-keep_buffer_size:]
                            start_idx = latest_data.find(b'$')
                            if start_idx != -1:
                                clean_payload = latest_data[start_idx:]
                                try:
                                    ser.write(clean_payload)
                                    ser.flush()

                                    # Log payload to com live terminal
                                    sentence_str = clean_payload.decode("ascii", errors="ignore")
                                    self.log_com_stream(sentence_str)
                                except serial.SerialTimeoutException:
                                    pass

                            for _ in range(int(poll_interval / 0.01)):
                                if not self.telemetry_running.get(stream_key, False):
                                    break
                                time.sleep(0.01)
                        else:
                            time.sleep(0.01)

                except (ConnectionRefusedError, ConnectionResetError, socket.error, socket.timeout) as e:
                    self.log_message(f"{thread_name} Connection issue: {e}. Reconnecting in 5s...")
                    self.root.after(0, self.update_telemetry_indicator, stream_key, "yellow")
                    if sock:
                        sock.close()

                    for _ in range(50):
                        if not self.telemetry_running.get(stream_key, False):
                            break
                        time.sleep(0.1)

        except Exception as e:
            self.log_message(f"{thread_name} CRITICAL ERROR: {e}")
            self.root.after(0, self.update_telemetry_indicator, stream_key, "red")
        finally:
            if ser:
                try:
                    ser.close()
                except Exception:
                    pass
                self.log_message(f"{thread_name} Closed {com_port}")
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
            self.root.after(0, self.update_telemetry_indicator, stream_key, "red")
            self.log_message(f"{thread_name} Bridge stopped.")

    def run_tcp_udp_bridge(self, mapping_id, tcp_port, udp_ip, udp_port):
        """Thread worker for a single TCP-to-UDP coalescing bridge."""
        thread_name = f"[TCP:{tcp_port} -> UDP {udp_ip}:{udp_port}]"
        self.log_message(f"Starting UDP bridge {thread_name}...")

        stream_key = ("udp", mapping_id)
        self.root.after(0, self.update_telemetry_indicator, stream_key, "yellow")

        tcp_conn = None
        udp_sock = None

        try:
            udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            if udp_ip == "255.255.255.255":
                udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

            while self.telemetry_running.get(stream_key, False):
                server_ip = self.server_ip_var.get().strip()
                try:
                    self.log_message(f"{thread_name} Connecting to {server_ip}:{tcp_port}...")
                    tcp_conn = socket.create_connection((server_ip, tcp_port), timeout=5)

                    self.log_message(f"{thread_name} Connected. Streaming to UDP...")
                    self.root.after(0, self.update_telemetry_indicator, stream_key, "green")

                    file_obj = tcp_conn.makefile("r", encoding="ascii", errors="ignore")
                    tcp_conn.settimeout(None)

                    for line in file_obj:
                        if not self.telemetry_running.get(stream_key, False):
                            break
                        if line.startswith("$") or line.startswith("!"):
                            payload = line.encode("ascii")
                            try:
                                udp_sock.sendto(payload, (udp_ip, udp_port))

                                # Log sentence line to udp live terminal
                                self.log_udp_stream(line)
                            except Exception as ex:
                                self.log_message(f"{thread_name} UDP send error: {ex}")

                    file_obj.close()
                    tcp_conn.close()

                except (OSError, ConnectionError, socket.timeout) as e:
                    self.log_message(f"{thread_name} Connection error: {e}. Reconnecting in 3s...")
                    self.root.after(0, self.update_telemetry_indicator, stream_key, "yellow")
                    if tcp_conn:
                        try:
                            tcp_conn.close()
                        except Exception:
                            pass

                    for _ in range(30):
                        if not self.telemetry_running.get(stream_key, False):
                            break
                        time.sleep(0.1)

        except Exception as e:
            self.log_message(f"{thread_name} CRITICAL ERROR: {e}")
            self.root.after(0, self.update_telemetry_indicator, stream_key, "red")
        finally:
            if tcp_conn:
                try:
                    tcp_conn.close()
                except Exception:
                    pass
            if udp_sock:
                try:
                    udp_sock.close()
                except Exception:
                    pass
            self.root.after(0, self.update_telemetry_indicator, stream_key, "red")
            self.log_message(f"{thread_name} UDP Bridge stopped.")

    def add_tcp_com_mapping_ui(self):
        try:
            tcp_port = int(self.new_tcp_port_com_var.get().strip())
        except ValueError:
            messagebox.showwarning("Invalid Input", "TCP Port must be a numeric integer.")
            return

        com_port = self.new_com_port_entry.get().strip()
        try:
            baud_rate = int(self.new_baud_com_var.get().strip())
        except ValueError:
            messagebox.showwarning("Invalid Input", "Baud rate must be a numeric integer.")
            return

        if not com_port:
            messagebox.showwarning("Missing COM Port", "Please select or type a COM port.")
            return

        self.db.add_tcp_com_mapping(tcp_port, com_port, baud_rate)
        self.new_tcp_port_com_var.set("")
        self.refresh_telemetry_mappings_ui()
        self.log_message(f"Added TCP to COM Bridge mapping: TCP:{tcp_port} -> {com_port}")

    def add_tcp_udp_mapping_ui(self):
        try:
            tcp_port = int(self.new_tcp_port_udp_var.get().strip())
        except ValueError:
            messagebox.showwarning("Invalid Input", "TCP Port must be a numeric integer.")
            return

        udp_ip = self.new_udp_ip_var.get().strip()
        try:
            udp_port = int(self.new_udp_port_var.get().strip())
        except ValueError:
            messagebox.showwarning("Invalid Input", "UDP Port must be a numeric integer.")
            return

        if not udp_ip:
            messagebox.showwarning("Missing IP", "Please specify a target UDP IP (e.g., 127.0.0.1).")
            return

        self.db.add_tcp_udp_mapping(tcp_port, udp_ip, udp_port)
        self.new_tcp_port_udp_var.set("")
        self.refresh_telemetry_mappings_ui()
        self.log_message(f"Added TCP to UDP Bridge mapping: TCP:{tcp_port} -> UDP {udp_ip}:{udp_port}")

    def delete_telemetry_mapping(self, type_, mapping_id):
        key = (type_, mapping_id)
        if self.telemetry_running.get(key, False):
            messagebox.showwarning("Bridge Running", "Cannot delete a running mapping. Please stop it first.")
            return

        if type_ == "com":
            self.db.delete_tcp_com_mapping(mapping_id)
            self.log_message(f"Deleted TCP to COM mapping ID {mapping_id}.")
        elif type_ == "udp":
            self.db.delete_tcp_udp_mapping(mapping_id)
            self.log_message(f"Deleted TCP to UDP mapping ID {mapping_id}.")

        self.refresh_telemetry_mappings_ui()

    def refresh_telemetry_mappings_ui(self):
        """Clears and rebuilds the active telemetry mappings rows in both columns."""
        # --- 1. TCP to COM Mappings ---
        for widget in self.com_list_inner.winfo_children():
            widget.destroy()

        com_mappings = self.db.get_tcp_com_mappings()
        for mapping in com_mappings:
            mapping_id, tcp_port, com_port, baud_rate = mapping
            stream_key = ("com", mapping_id)
            is_running = self.telemetry_running.get(stream_key, False)

            row_frame = tk.Frame(self.com_list_inner, pady=3)
            row_frame.pack(fill=tk.X, anchor="w")

            tk.Label(
                row_frame, text=f"TCP:{tcp_port} → {com_port}", width=22, anchor="w"
            ).pack(side=tk.LEFT, padx=(5, 10))

            indicator = tk.Canvas(
                row_frame, width=15, height=15, highlightthickness=0, bg=row_frame.cget("bg")
            )
            indicator.pack(side=tk.LEFT, padx=5)
            indicator.create_oval(2, 2, 13, 13, fill="grey", outline="darkgrey")
            self.telemetry_indicators[stream_key] = indicator

            if is_running:
                self.update_telemetry_indicator(stream_key, "green")
            else:
                self.update_telemetry_indicator(stream_key, "grey")

            btn_text = "Stop" if is_running else "Start"
            btn_bg = "firebrick1" if is_running else "lightgrey"
            toggle_btn = tk.Button(
                row_frame, text=btn_text, width=6, bg=btn_bg,
                command=lambda m_id=mapping_id: self.toggle_telemetry_stream("com", m_id)
            )
            toggle_btn.pack(side=tk.LEFT, padx=5)

            del_state = tk.DISABLED if is_running else tk.NORMAL
            delete_btn = tk.Button(
                row_frame, text="Delete", width=6, state=del_state,
                command=lambda m_id=mapping_id: self.delete_telemetry_mapping("com", m_id)
            )
            delete_btn.pack(side=tk.LEFT, padx=5)

        # --- 2. TCP to UDP Mappings ---
        for widget in self.udp_list_inner.winfo_children():
            widget.destroy()

        udp_mappings = self.db.get_tcp_udp_mappings()
        for mapping in udp_mappings:
            mapping_id, tcp_port, udp_ip, udp_port = mapping
            stream_key = ("udp", mapping_id)
            is_running = self.telemetry_running.get(stream_key, False)

            row_frame = tk.Frame(self.udp_list_inner, pady=3)
            row_frame.pack(fill=tk.X, anchor="w")

            tk.Label(
                row_frame, text=f"TCP:{tcp_port} → UDP:{udp_port}", width=22, anchor="w"
            ).pack(side=tk.LEFT, padx=(5, 10))

            indicator = tk.Canvas(
                row_frame, width=15, height=15, highlightthickness=0, bg=row_frame.cget("bg")
            )
            indicator.pack(side=tk.LEFT, padx=5)
            indicator.create_oval(2, 2, 13, 13, fill="grey", outline="darkgrey")
            self.telemetry_indicators[stream_key] = indicator

            if is_running:
                self.update_telemetry_indicator(stream_key, "green")
            else:
                self.update_telemetry_indicator(stream_key, "grey")

            btn_text = "Stop" if is_running else "Start"
            btn_bg = "firebrick1" if is_running else "lightgrey"
            toggle_btn = tk.Button(
                row_frame, text=btn_text, width=6, bg=btn_bg,
                command=lambda m_id=mapping_id: self.toggle_telemetry_stream("udp", m_id)
            )
            toggle_btn.pack(side=tk.LEFT, padx=5)

            del_state = tk.DISABLED if is_running else tk.NORMAL
            delete_btn = tk.Button(
                row_frame, text="Delete", width=6, state=del_state,
                command=lambda m_id=mapping_id: self.delete_telemetry_mapping("udp", m_id)
            )
            delete_btn.pack(side=tk.LEFT, padx=5)

    # --- LOCAL VESSEL SIMULATOR CONTROLS & NATIVE MAP DRAWING ---

    def load_vessel_sim_config(self):
        saved_speed = self.db.get_setting("vessel_sim_speed")
        if saved_speed:
            try:
                self.vessel_speed_var.set(float(saved_speed))
                with STATE.lock:
                    STATE.vessel_state['default_speed'] = float(saved_speed)
            except ValueError:
                pass
        saved_bread = self.db.get_setting("vessel_sim_breadcrumbs")
        if saved_bread:
            enabled = (saved_bread == "True")
            self.vessel_breadcrumbs_var.set(enabled)
            with STATE.lock:
                STATE.vessel_state['breadcrumb_enabled'] = enabled

        # Auto-start previously active broadcast ports
        saved_ports = self.db.get_vessel_sim_ports()
        threads_to_start = []
        with STATE.lock:
            for sport in saved_ports:
                _, dev_name, port, protocol, hz, baud = sport
                success, msg, thread = add_port_logic(port, dev_name, protocol, hz, baud)
                if success:
                    threads_to_start.append(thread)
                    self.log_message(f"[VesselSim] Auto-started broadcast port: {dev_name} on {port} ({protocol})")
                else:
                    self.log_message(f"[VesselSim] Warning: Could not auto-start port {port}: {msg}")

        for thread in threads_to_start:
            thread.start()

        self.refresh_vessel_sim_ports_ui()

    def populate_vessel_sim_files_tree(self):
        """Loads Year/Vessel/Files tree for Parquet File Replay from data/ folder."""
        data_dir = 'data'
        tree = {}
        if os.path.exists(data_dir) and HAS_REPLAY_GIS:
            try:
                for year_dir in [d for d in os.listdir(data_dir) if d.startswith('survey_year=') and os.path.isdir(os.path.join(data_dir, d))]:
                    year = year_dir.split('=')[1]
                    tree[year] = {}
                    vessel_path = os.path.join(data_dir, year_dir)
                    for vessel_dir in [d for d in os.listdir(vessel_path) if d.startswith('vessel_name=') and os.path.isdir(os.path.join(vessel_path, d))]:
                        vessel = vessel_dir.split('=')[1]
                        final_path = os.path.join(vessel_path, vessel_dir)
                        files = [f for f in os.listdir(final_path) if f.endswith('.parquet')]
                        if files:
                            tree[year][vessel] = files
            except Exception as e:
                self.log_message(f"[VesselSim] Error reading parquet data structure: {e}")

        self.vessel_file_tree = tree
        years = list(tree.keys())
        if years:
            self.vessel_year_cb["values"] = years
            self.vessel_year_cb.set(years[0])
            self.on_vessel_year_changed()
        else:
            self.vessel_year_cb["values"] = ["No data"]
            self.vessel_year_cb.set("No data")

    def on_vessel_source_mode_changed(self, event=None):
        mode = self.vessel_source_cb.get()
        if mode == "File Replay":
            if not HAS_REPLAY_GIS:
                messagebox.showwarning("Missing Dependencies", "File Replay requires pandas/geopandas/shapely packages to be installed.")
                self.vessel_source_cb.set("Simulation")
                return
            self.vessel_replay_options_frame.pack(fill=tk.X, pady=5)
        else:
            self.vessel_replay_options_frame.pack_forget()

    def on_vessel_year_changed(self, event=None):
        year = self.vessel_year_cb.get().strip()
        if year in self.vessel_file_tree:
            vessels = list(self.vessel_file_tree[year].keys())
            self.vessel_vessel_cb["values"] = vessels
            if vessels:
                self.vessel_vessel_cb.set(vessels[0])
                self.on_vessel_vessel_changed()
        else:
            self.vessel_vessel_cb["values"] = []
            self.vessel_vessel_cb.set("")
            self.vessel_file_cb["values"] = []
            self.vessel_file_cb.set("")

    def on_vessel_vessel_changed(self, event=None):
        year = self.vessel_year_cb.get().strip()
        vessel = self.vessel_vessel_cb.get().strip()
        if year in self.vessel_file_tree and vessel in self.vessel_file_tree[year]:
            files = self.vessel_file_tree[year][vessel]
            self.vessel_file_cb["values"] = files
            if files:
                self.vessel_file_cb.set(files[0])
        else:
            self.vessel_file_cb["values"] = []
            self.vessel_file_cb.set("")

    def start_vessel_simulation_ui(self):
        mode = self.vessel_source_cb.get()
        with STATE.lock:
            if STATE.data_source_thread:
                messagebox.showwarning("Already Running", "Vessel Simulator is already running.")
                return
            STATE.clear_history()
            STATE.data_source_stop_event = threading.Event()

            if mode == "Simulation":
                STATE.current_mode = "Simulation"
                STATE.data_source_thread = threading.Thread(
                    target=simulation_thread, args=(STATE.data_source_stop_event,), daemon=True
                )
                self.log_message("[VesselSim] 10Hz Core Simulation Engine started successfully.")
            elif mode == "File Replay":
                if not HAS_REPLAY_GIS:
                    return
                year = self.vessel_year_cb.get().strip()
                vessel = self.vessel_vessel_cb.get().strip()
                filename = self.vessel_file_cb.get().strip()
                if not year or not vessel or not filename or year == "No data":
                    messagebox.showwarning("Missing File Selection", "Please select a Year, Vessel, and Parquet File first.")
                    return
                path = os.path.join('data', f"survey_year={year}", f"vessel_name={vessel}", filename)
                if not os.path.exists(path):
                    messagebox.showerror("Not Found", f"Parquet file not found at {path}")
                    return
                STATE.current_mode, STATE.current_file = "File Replay", filename
                STATE.data_source_thread = threading.Thread(
                    target=file_replay_thread, args=(path, STATE.data_source_stop_event), daemon=True
                )
                self.log_message(f"[VesselSim] Parquet File Replay started for {filename}")

            STATE.data_source_thread.start()

    def stop_vessel_simulation_ui(self):
        with STATE.lock:
            if STATE.data_source_thread:
                STATE.data_source_stop_event.set()
                STATE.data_source_thread.join(timeout=1)
                STATE.data_source_thread, STATE.current_mode = None, "Idle"
                self.log_message("[VesselSim] Simulation engine stopped.")

    def update_vessel_speed_from_slider(self, val):
        try:
            speed = float(val)
            with STATE.lock:
                STATE.vessel_state['default_speed'] = speed
            self.db.set_setting("vessel_sim_speed", f"{speed:.1f}")
        except ValueError:
            pass

    def update_vessel_speed_from_spin(self):
        try:
            speed = self.vessel_speed_var.get()
            with STATE.lock:
                STATE.vessel_state['default_speed'] = speed
            self.db.set_setting("vessel_sim_speed", f"{speed:.1f}")
        except ValueError:
            pass

    def toggle_vessel_breadcrumbs(self):
        enabled = self.vessel_breadcrumbs_var.get()
        with STATE.lock:
            STATE.vessel_state['breadcrumb_enabled'] = enabled
        self.db.set_setting("vessel_sim_breadcrumbs", str(enabled))

    def add_vessel_sim_port_ui(self):
        dev_name = self.vessel_device_cb.get().strip()
        port_str = self.vessel_port_cb.get().strip()
        protocol = self.vessel_protocol_cb.get().strip()
        hz = int(self.vessel_hz_cb.get().split()[0].strip())
        baud = int(self.vessel_baud_cb.get().strip())

        if not dev_name or not port_str:
            messagebox.showwarning("Missing Fields", "Please select both a device and a COM port.")
            return

        match = re.search(r'\d+', port_str)
        if not match:
            messagebox.showwarning("Invalid Port", "Select a valid COM port (e.g. COM13).")
            return
        port_num = int(match.group())
        port_val = 6000 + port_num

        with STATE.lock:
            success, msg, thread = add_port_logic(port_val, dev_name, protocol, hz, baud)
            if success:
                thread.start()
                self.db.add_vessel_sim_port(dev_name, port_val, protocol, hz, baud)
                self.log_message(f"[VesselSim] Configured and running: {msg}")
                self.refresh_vessel_sim_ports_ui()
            else:
                messagebox.showerror("Error", f"Failed to add broadcast port: {msg}")

    def remove_vessel_sim_port_ui(self, port):
        with STATE.lock:
            if port in STATE.stop_events:
                STATE.stop_events[port].set()
                STATE.server_threads[port].join(timeout=1)
                del STATE.server_threads[port]
                del STATE.stop_events[port]
                dev = next((n for n, i in STATE.active_ports.items() if i['port'] == port), None)
                if dev:
                    del STATE.active_ports[dev]
                self.db.delete_vessel_sim_port(port)
                self.log_message(f"[VesselSim] Removed broadcast port {port}")
                self.refresh_vessel_sim_ports_ui()

    def refresh_vessel_sim_ports_ui(self):
        """Redraws the active broadcast ports list on the Vessel Simulator tab."""
        for widget in self.vessel_ports_list_inner.winfo_children():
            widget.destroy()

        active_ports = list(STATE.active_ports.items())
        active_ports.sort(key=lambda x: x[1]['port'])

        for dev_name, info in active_ports:
            row_frame = tk.Frame(self.vessel_ports_list_inner, pady=1)
            row_frame.pack(fill=tk.X, anchor="w")

            com_lbl = f"COM{info['port'] - 6000}"
            label_text = f"{com_lbl}-{dev_name} ({info['protocol']}|{info['hz']}Hz)"
            tk.Label(row_frame, text=label_text, font=("Consolas", 8), anchor="w", width=34).pack(side=tk.LEFT, padx=2)

            stop_btn = tk.Button(
                row_frame, text="X", bg="firebrick2", fg="white", font=("Arial", 7, "bold"), width=2, height=1,
                command=lambda p=info['port']: self.remove_vessel_sim_port_ui(p)
            )
            stop_btn.pack(side=tk.LEFT, padx=2)

    def log_vessel_nmea(self, sentence_str):
        """Appends simulated NMEA sentence to Vessel Simulator NMEA stream console safely."""
        def _insert():
            self.vessel_nmea_text.config(state=tk.NORMAL)
            self.vessel_nmea_text.insert(tk.END, sentence_str)
            lines_str = self.vessel_nmea_text.index('end-1c').split('.')[0]
            if lines_str:
                lines = int(lines_str)
                if lines > 200:
                    self.vessel_nmea_text.delete("1.0", f"{lines - 200}.0")
            self.vessel_nmea_text.see(tk.END)
            self.vessel_nmea_text.config(state=tk.DISABLED)

        try:
            self.root.after(0, _insert)
        except Exception:
            pass

    def clear_vessel_nmea_console(self):
        self.vessel_nmea_text.config(state=tk.NORMAL)
        self.vessel_nmea_text.delete(1.0, tk.END)
        self.vessel_nmea_text.config(state=tk.DISABLED)

    def redraw_map_canvas(self):
        """Draws the dynamic 2D tracking map on the native Tkinter Canvas."""
        if not hasattr(self, "map_canvas"):
            return

        # Clear canvas
        self.map_canvas.delete("all")

        width = self.map_canvas.winfo_width()
        height = self.map_canvas.winfo_height()
        if width < 10 or height < 10:
            width, height = 300, 300  # Default fallback if not yet rendered

        cx, cy = width / 2, height / 2
        scale = self.vessel_map_zoom_var.get()

        with STATE.lock:
            ship_lat = STATE.vessel_state['lat']
            ship_lon = STATE.vessel_state['lon']
            heading = STATE.vessel_state['heading']
            breadcrumbs_enabled = STATE.vessel_state['breadcrumb_enabled']
            breadcrumbs = list(STATE.track_history)

        cos_lat = math.cos(math.radians(ship_lat))

        # Helper function to project lat/lon to canvas pixels
        def project(lat, lon):
            dx = (lon - ship_lon) * cos_lat * scale
            dy = (ship_lat - lat) * scale
            return cx + dx, cy + dy

        # 1. Draw Lat/Lon grid lines & labels
        lon_span = (width / 2) / (scale * cos_lat)
        lat_span = (height / 2) / scale

        min_lon = ship_lon - lon_span
        max_lon = ship_lon + lon_span
        min_lat = ship_lat - lat_span
        max_lat = ship_lat + lat_span

        grid_step = 0.05
        start_lon = math.floor(min_lon / grid_step) * grid_step
        start_lat = math.floor(min_lat / grid_step) * grid_step

        curr_lon = start_lon
        while curr_lon <= max_lon:
            x, _ = project(ship_lat, curr_lon)
            self.map_canvas.create_line(x, 0, x, height, fill="#1c2d3d", dash=(2, 2))
            self.map_canvas.create_text(x, height - 10, text=f"{abs(curr_lon):.2f}°W", fill="#5a7a8a", font=("Arial", 7))
            curr_lon += grid_step

        curr_lat = start_lat
        while curr_lat <= max_lat:
            _, y = project(curr_lat, ship_lon)
            self.map_canvas.create_line(0, y, width, y, fill="#1c2d3d", dash=(2, 2))
            self.map_canvas.create_text(25, y, text=f"{curr_lat:.2f}°N", fill="#5a7a8a", font=("Arial", 7))
            curr_lat += grid_step

        # 2. Draw WCGBTS grid boundary box (Lat 32.5N to 48.5N, Lon 125.5W to 117.5W)
        pts = [
            project(48.5, -125.5),
            project(48.5, -117.5),
            project(32.5, -117.5),
            project(32.5, -125.5)
        ]
        self.map_canvas.create_polygon(
            pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1],
            outline="orange", fill="", dash=(3, 3)
        )
        self.map_canvas.create_text(
            pts[0][0] + 70, pts[0][1] + 15, text="WCGBTS Grid Box", fill="orange", font=("Arial", 7, "italic")
        )

        # 3. Draw Breadcrumbs history (trail)
        if breadcrumbs_enabled and len(breadcrumbs) > 1:
            line_pts = []
            for b_lat, b_lon, _ in breadcrumbs:
                px, py = project(b_lat, b_lon)
                line_pts.extend([px, py])
            if len(line_pts) >= 4:
                self.map_canvas.create_line(line_pts, fill="#00aeff", width=1.5, capstyle=tk.ROUND, joinstyle=tk.ROUND)

        # 4. Draw Current Vessel (Stylized triangle)
        rad = math.radians(heading)
        cos_h, sin_h = math.cos(rad), math.sin(rad)

        local_vertices = [(0, -12), (-6, 8), (0, 4), (6, 8)]
        rotated_vertices = []
        for lx, ly in local_vertices:
            rx = lx * cos_h - ly * sin_h
            ry = lx * sin_h + ly * cos_h
            rotated_vertices.append((cx + rx, cy + ry))

        self.map_canvas.create_polygon(
            rotated_vertices[0][0], rotated_vertices[0][1],
            rotated_vertices[1][0], rotated_vertices[1][1],
            rotated_vertices[2][0], rotated_vertices[2][1],
            rotated_vertices[3][0], rotated_vertices[3][1],
            fill="#ff4500", outline="white", width=1
        )

    def poll_vessel_simulator_state(self):
        """Periodically polls the global shared AppState to update labels and map canvas redrawing."""
        try:
            with STATE.lock:
                mode = STATE.current_mode
                lat = STATE.vessel_state.get('lat', 0.0)
                lon = STATE.vessel_state.get('lon', 0.0)
                sog = STATE.vessel_state.get('sog_knots', 0.0)
                depth = STATE.vessel_state.get('seafloor_depth', 0.0)
                kpi = STATE.vessel_state.get('area_swept_kpi', 0.0)

            # Update status header
            if mode == "File Replay":
                self.vessel_status_label.config(text=f"Status: Replay ({STATE.current_file})")
            else:
                self.vessel_status_label.config(text=f"Status: {mode}")

            # Update coordinates/speed readout console
            self.vessel_info_label.config(
                text=f"Latitude:   {lat:10.6f}° N\n"
                     f"Longitude:  {lon:10.6f}° W\n"
                     f"Vess Speed: {sog:10.2f} knots\n"
                     f"Floor Depth:{depth:10.1f} meters\n"
                     f"Area Swept: {kpi:10.2f} hectares"
            )

            # Redraw Native GIS Canvas map
            self.redraw_map_canvas()

            # Toggle button states
            if mode != "Idle":
                self.vessel_start_btn.config(state=tk.DISABLED)
                self.vessel_stop_btn.config(state=tk.NORMAL)
            else:
                self.vessel_start_btn.config(state=tk.NORMAL)
                self.vessel_stop_btn.config(state=tk.DISABLED)

        except Exception:
            pass

        # Poll again in 500ms for smooth map rendering
        self.root.after(500, self.poll_vessel_simulator_state)

    def on_close(self):
        """Stop all thread loops cleanly upon exiting Tkinter."""
        for p in self.printers:
            self.printer_running[p] = False

        for key in list(self.telemetry_running.keys()):
            self.telemetry_running[key] = False

        # Stop local vessel simulator threads
        with STATE.lock:
            if STATE.data_source_thread:
                STATE.data_source_stop_event.set()
            for stop_ev in STATE.stop_events.values():
                stop_ev.set()

        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    app = HardwareSimulatorApp(root)
    root.mainloop()
