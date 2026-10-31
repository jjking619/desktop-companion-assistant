# Desktop Companion Assistant

[中文](README_zh.md) | English

Desktop Companion Assistant is a desktop companion for the Quectel PI M2 (RK3576, Debian ARM64). It combines a transparent Electron interface, a VRM character, voice conversation, on-demand hand-gesture recognition, and microphone-array direction tracking.

## Features

- A draggable VRM companion with continuous conversation, speech animation, and a switchable studio or transparent background.
- Optional Bailian speech recognition, language-model replies, and speech synthesis. Credentials are kept in a local `.env` file.
- On-demand hand preview and gesture recognition. The Linux launcher uses the RK3576 NPU by default; the camera and model are opened only while the preview is active.
- Optional microphone-array direction tracking.

## Hardware Requirements

- Quectel PI M2 single-board computer with RK3576 and Debian ARM64.
- A logged-in desktop with an accessible X11 display for the Electron interface. Backend-only mode does not require a graphical desktop.
- USB camera for gesture preview.
- Microphone array and audio output for voice features. Check detected audio devices with `arecord -l`.

## Software Environment

| Component | Requirement |
| --- | --- |
| Python | 3.11 (installed with `uv`) |
| Node.js and npm | Node.js 22.16.0 ARM64 build (the launcher's default path) |
| Python packages | Installed from the root `requirements.txt` |
| Frontend packages | Installed from `aura_app/frontend/package-lock.json` |
| Linux audio / desktop tools | `alsa-utils`, `espeak-ng`, `libespeak1`; `x11-utils` for Electron mode |

Use Python 3.11 and an ARM64 Node.js build supported by the board. The RKNN Python package in `requirements.txt` and the bundled models target RK3576.

## Installation

Run the following commands on the board. The commands below use the public GitHub URL; if the repository is private, configure an SSH key on the board and use the SSH clone URL instead.

1. Install system utilities and clone the repository:

   ```bash
   sudo apt update
   sudo apt install -y ca-certificates curl git alsa-utils espeak-ng libespeak1 x11-utils
   cd "$HOME"
   git clone https://github.com/jjking619/demo-desktop-companion-assistant.git
   cd demo-desktop-companion-assistant
   ```

2. Install Python 3.11. Debian 13's default Python is newer; use `uv` to install the required Python version without changing the system Python:

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   export PATH="$HOME/.local/bin:$PATH"
   uv python install 3.11
   uv python find 3.11
   ```

   If `uv` is already installed, skip its installer and ensure `~/.local/bin` is on `PATH`.

3. Install the tested Node.js 22.16.0 ARM64 build from the official Node.js distribution and verify its SHA-256 checksum:

   ```bash
   cd /tmp
   curl -fLO https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-arm64.tar.xz
   printf '%s  %s\n' \
     'eab80cb88f8fda1e65f5e8d0420c9809bdb320b03fd34976ab7161b6e703b910' \
     'node-v22.16.0-linux-arm64.tar.xz' | sha256sum -c -
   mkdir -p "$HOME/.local/opt"
   tar -xJf node-v22.16.0-linux-arm64.tar.xz -C "$HOME/.local/opt"
   rm node-v22.16.0-linux-arm64.tar.xz
   export PATH="$HOME/.local/opt/node-v22.16.0-linux-arm64/bin:$PATH"
   node --version
   npm --version
   ```

   `node --version` should print `v22.16.0`. These `PATH` exports apply to the current terminal; add them to `~/.profile` if you want them in new login sessions. The launcher adds this exact Node directory automatically when it exists. If you use another Node installation path, make sure it is on `PATH` before launching.

4. Create the backend virtual environment and install its dependencies:

   ```bash
   cd ~/demo-desktop-companion-assistant
   uv venv --python 3.11 aura_app/backend/.venv
   uv pip install --python aura_app/backend/.venv/bin/python -r requirements.txt
   ```

5. Install the frontend dependencies:

   ```bash
   cd aura_app/frontend
   npm ci
   cd ../..
   ```

   The launcher builds the frontend when starting the Electron interface.

6. Configure voice services if using Bailian. The example file selects Bailian; add a valid API key and check the microphone device before starting:

   ```bash
   cp aura_app/backend/bailian.env.example .env
   chmod 600 .env
   ```

   Edit `.env` locally and set `DASHSCOPE_API_KEY`.

7. Download [AvatarSample_A.vrm from madjin/vrm-samples](https://github.com/madjin/vrm-samples/blob/master/vroid/stable/AvatarSample_A.vrm), keeping its original filename:

   ```bash
   mkdir -p aura_app/frontend/public/characters
   curl --fail --location \
     https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/stable/AvatarSample_A.vrm \
     --output aura_app/frontend/public/characters/AvatarSample_A.vrm
   printf '%s  %s\n' \
     'b86b0b8a66d48911431d6f920a5211a974226f83aa672eca3f3dfade58ac346e' \
     'aura_app/frontend/public/characters/AvatarSample_A.vrm' | sha256sum -c -
   ```

   The checksum should report `OK`; do not start the application if downloading or verification fails. The model is not distributed with this repository and is not CC0. Read the [official VRoid AvatarSample_A/B/C conditions of use](https://vroid.pixiv.help/hc/en-us/articles/4402394424089) before using, modifying, or redistributing it.


## Project Structure

```text
demo-desktop-companion-assistant/
├── aura_app/
│   ├── backend/                 # FastAPI, voice, audio, and gesture processing
│   │   └── models/rknn/         # RK3576 hand models and license files
│   └── frontend/                # Electron, React, and VRM interface
├── StartAURA_Linux.sh           # Linux launcher
├── requirements.txt             # Python dependencies
├── README.md                    # English documentation (GitHub default)
├── README_zh.md                 # Chinese documentation
└── LICENSE
```

`.env` and `AvatarSample_A.vrm` are local files and are intentionally excluded from Git.

## Run the Program

Run the Electron interface from a logged-in desktop terminal:

```bash
cd ~/demo-desktop-companion-assistant
./StartAURA_Linux.sh
```

The launcher builds the frontend, starts the backend, and opens the transparent companion window. Press `Ctrl+C` in that terminal to stop it.

To run only the backend, without X11 or Electron:

```bash
./StartAURA_Linux.sh --backend-only
curl --fail http://127.0.0.1:8000/
```

## Common Settings

Set an option before launching the assistant. Restart the application after changing settings.

| Variable | Linux launcher default | Purpose |
| --- | --- | --- |
| `AURA_GESTURE_BACKEND` | `rknn` | Gesture backend: `rknn` (RK3576 NPU), `legacy` (MediaPipe CPU), or `remote`. |
| `AURA_GESTURE_VOLUME` | `1` | Enable vertical swipes to adjust the assistant's speech volume. Set to `0` to disable. Recognition still starts only when gesture preview is opened. |
| `AURA_CAMERA` | First `/dev/v4l/by-id/*-video-index0` device | Select the camera device. |
| `AURA_SOUND_LOCALIZATION` | `1` | Enable microphone-array direction tracking. Set to `0` to disable. |
| `AURA_SOFTWARE_RENDERING` | `0` | Use Mali GPU rendering. Set to `1` to explicitly use software rendering. |
| `AURA_ALSA_DEVICE` | Board speaker device | Select an ALSA output device. Set to an empty value to use the PipeWire/PulseAudio path when available. |

For example, to disable swipe volume:

```bash
AURA_GESTURE_VOLUME=0 ./StartAURA_Linux.sh
```

Vertical swipes change only the assistant's own speech playback gain, not the system mixer or other applications. Use the Dock's gesture-preview control to start and stop camera capture.

## Character Model

The active model is loaded from `aura_app/frontend/public/characters/AvatarSample_A.vrm`. To use another authorized humanoid VRM, place it under `aura_app/frontend/public/characters/`, update `vrmCharacter.model` in `aura_app/frontend/src/components/vrmCharacter.ts`, and rebuild the frontend. The model should provide `aa`, `ih`, `ou`, `ee`, and `oh` mouth expressions. Check all model and animation licenses before redistribution.

## Troubleshooting and Issues

- **Missing Python environment or `python3.11`:** use `uv python install 3.11`, then create the virtual environment and install `requirements.txt` as shown above. Debian 13's system Python version is not used.
- **`uv` not found:** add `~/.local/bin` to `PATH` or run the official uv installer shown above.
- **`node` or `npm` not found:** add `$HOME/.local/opt/node-v22.16.0-linux-arm64/bin` to `PATH`, or repeat the Node.js installation step. Electron mode also requires `x11-utils` and a logged-in desktop session; use `--backend-only` on a headless terminal.
- **Clone over SSH fails:** configure the board's GitHub SSH key, or use the HTTPS clone URL if the repository is public.
- **No microphone input:** check `arecord -l` and update `AURA_MIC_DEVICE` in `.env`. For microphone-array direction tracking, check the board's array device and `AURA_SOUND_DEVICE`.
- **RKNN preview fails to load:** confirm the RKNN files and `manifest.json` exist in `aura_app/backend/models/rknn/`, then check the backend error message. The models require the RK3576 runtime.
- **No character appears:** confirm the local VRM file is at the path above and is named exactly `AvatarSample_A.vrm`.

For issues, include the board model, operating system, startup command, and relevant error output. Remove API keys and other secrets before sharing logs.

## License

See [LICENSE](LICENSE) for the project license. Bundled RKNN models and character assets have separate licensing terms; retain their license and attribution files and verify permissions before redistribution.
