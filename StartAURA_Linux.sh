#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$ROOT/aura_app/backend/.venv/bin/python"
NODE_HOME="$HOME/.local/opt/node-v22.16.0-linux-arm64/bin"
export AURA_AUDIO_SINK="${AURA_AUDIO_SINK:-alsa_output.platform-es8389-sound.analog-stereo}"
export AURA_ALSA_DEVICE="${AURA_ALSA_DEVICE-plughw:CARD=rockchipes8389,DEV=0}"
if [ "$AURA_ALSA_DEVICE" = "plughw:CARD=rockchipes8389,DEV=0" ]; then
    amixer -c rockchipes8389 sset 'spk switch' on >/dev/null
fi
export AURA_SOFTWARE_RENDERING="${AURA_SOFTWARE_RENDERING:-0}"
export AURA_GESTURE_VOLUME="${AURA_GESTURE_VOLUME:-1}"
export AURA_GESTURE_BACKEND="${AURA_GESTURE_BACKEND:-rknn}"
export AURA_SOUND_LOCALIZATION="${AURA_SOUND_LOCALIZATION:-1}"
export AURA_SOUND_FRONT_DEG="${AURA_SOUND_FRONT_DEG:-181.03}"
if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0" ]; then
    export XDG_SESSION_TYPE=wayland
fi
if [ -d "$NODE_HOME" ]; then
    export PATH="$NODE_HOME:$PATH"
fi
if [ "${1:-}" != "" ] && [ "${1:-}" != "--backend-only" ]; then
    echo "Usage: $0 [--backend-only]" >&2
    exit 1
fi
if [ ! -x "$PYTHON" ]; then
    echo "Missing Python environment. See README.md." >&2
    exit 1
fi
if [ "${1:-}" != "--backend-only" ]; then
    if ! command -v npm >/dev/null || ! command -v xdpyinfo >/dev/null; then
        echo "npm and xdpyinfo are required. See README.md." >&2
        exit 1
    fi
    if ! xdpyinfo >/dev/null 2>&1; then
        echo "No accessible X11 desktop. Run from your logged-in desktop terminal." >&2
        echo "For the camera/API only, use: $0 --backend-only" >&2
        exit 1
    fi
fi
if [ -z "${AURA_CAMERA:-}" ]; then
    for device in /dev/v4l/by-id/*-video-index0; do
        if [ -e "$device" ]; then
            export AURA_CAMERA="$device"
            break
        fi
    done
fi
if [ "${AURA_GESTURE_VOLUME:-0}" = "1" ]; then
    echo "Desktop Companion Assistant gestures OFF by default (camera/model stopped). Click the gesture button to enable recognition and preview; close it to release resources. Backend: ${AURA_GESTURE_BACKEND:-legacy}, camera: ${AURA_CAMERA:-0}; swipe up/down +/-5pp (assistant only)."
else
    echo "Desktop Companion Assistant gestures OFF by default (camera/model stopped). Click the gesture button to enable recognition and preview; close it to release resources. Backend: ${AURA_GESTURE_BACKEND:-legacy}, camera: ${AURA_CAMERA:-0}; gesture volume disabled."
fi
echo "Desktop Companion Assistant rendering preference: $AURA_SOFTWARE_RENDERING (0=GPU, 1=software)"
cd "$ROOT/aura_app/backend"
if [ "${1:-}" = "--backend-only" ]; then
    exec "$PYTHON" -u main.py
fi
if "$PYTHON" -c 'import socket; s=socket.create_connection(("127.0.0.1", 8000), timeout=1); s.close()' 2>/dev/null; then
    echo "Port 8000 is already occupied; stop the existing backend first." >&2
    exit 1
fi
BACKEND_PID=""
cleanup() {
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill "$BACKEND_PID"
        wait "$BACKEND_PID" || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$PYTHON" -u main.py &
BACKEND_PID=$!
ready=0
for ((attempt=0; attempt<60; attempt++)); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "Desktop Companion Assistant backend exited; check the error above." >&2
        exit 1
    fi
    if curl --fail --silent http://127.0.0.1:8000/ >/dev/null; then
        ready=1
        break
    fi
    sleep 0.5
done
if [ "$ready" != 1 ]; then
    echo "Desktop Companion Assistant backend did not become ready within 30 seconds." >&2
    exit 1
fi
cd "$ROOT/aura_app/frontend"
npm run build
# Select Xwayland before Electron initializes its native display backend.
npm start -- --ozone-platform=x11
