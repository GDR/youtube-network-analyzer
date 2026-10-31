#!/usr/bin/env python3
"""
Local collector for the YouTube Connectivity & GGC Analyzer Chrome Extension.
Listens on http://127.0.0.1:18999/ingest and appends every event in real-time
to logs/telemetry.jsonl so Antigravity can analyze live connectivity issues
without needing you to copy-paste curls!
"""

import json
import os
import socket
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 18999
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "telemetry.jsonl")

dns_cache = {}


def resolve_host(host: str):
    if not host or host == "unknown":
        return None
    if host in dns_cache:
        return dns_cache[host]
    try:
        ip = socket.gethostbyname(host)
        dns_cache[host] = ip
        return ip
    except Exception:
        return None


class TelemetryHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence default HTTP stdout logging
        pass

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/ingest":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            # If Chrome didn't populate serverIp on a failed/timed-out request, resolve it locally
            if payload.get("type") == "network_request":
                data = payload.get("data", {})
                host = data.get("parsed", {}).get("host")
                if not data.get("serverIp") and host and not data.get("parsed", {}).get("isFakeProbe"):
                    data["resolvedIpFallback"] = resolve_host(host)

                outcome = data.get("outcome")
                if outcome != "IGNORED_FAKE_PROBE":
                    rn = data.get("parsed", {}).get("rn")
                    ip = data.get("serverIp") or data.get("resolvedIpFallback") or "-"
                    dur = data.get("durationMs")
                    vid = data.get("videoId") or "-"
                    print(
                        f"[{datetime.now().strftime('%H:%M:%S')}] "
                        f"vid={vid} rn={rn} host={host} ip={ip} "
                        f"outcome={outcome} dur={dur}ms err={data.get('error') or '-'}"
                    )

            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")

            self.send_response(200)
            self._send_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as e:
            self.send_response(400)
            self._send_cors()
            self.end_headers()
            self.wfile.write(str(e).encode("utf-8"))


if __name__ == "__main__":
    print(f"YouTube Telemetry Collector listening on http://127.0.0.1:{PORT}/ingest")
    print(f"Writing live events to: {LOG_FILE}")
    server = HTTPServer(("127.0.0.1", PORT), TelemetryHandler)
    server.serve_forever()
