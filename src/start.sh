#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"

if [[ "${ENABLE_VNC:-false}" == "true" ]]; then
  export BROWSER_HEADLESS=false
  # Force virtual display (don’t inherit a bogus DISPLAY from the host)
  export DISPLAY=:99
  echo "Starting Xvfb on ${DISPLAY}..."
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension RANDR +render -noreset &
  XVFB_PID=$!

  # Let Xvfb come up before Node launches Chromium (avoids headless fallback / no window)
  sleep 2

  echo "Starting x11vnc on port 5900..."
  # For private/internal use. If you need access control, we should add VNC password + firewalling.
  x11vnc -display "${DISPLAY}" -rfbport 5900 -forever -shared -nopw -listen 0.0.0.0 &
  XVNC_PID=$!

  echo "Starting noVNC proxy on :${VNC_WEB_PORT:-6080}..."
  /opt/novnc/utils/novnc_proxy --listen "${VNC_WEB_PORT:-6080}" --vnc "127.0.0.1:5900" &
  NO_VNC_PID=$!

  # Ensure we shut everything down if the app exits.
  trap "kill ${XVFB_PID} ${XVNC_PID} ${NO_VNC_PID} 2>/dev/null || true" EXIT
fi

echo "Starting app..."
exec node src/index.js

