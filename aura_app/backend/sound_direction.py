from collections import deque
from concurrent.futures import CancelledError
import logging
import math
import os
import queue
import threading
import time

import numpy as np

from sound_localization.audio import Capture
from sound_localization.speech import Pipeline


LOGGER = logging.getLogger(__name__)


class NoSpeechTimeout(TimeoutError):
    """No valid utterance arrived within the local listening window."""


def direction_config():
    front = float(os.getenv("AURA_SOUND_FRONT_DEG", "181.03"))
    radius = float(os.getenv("AURA_SOUND_RADIUS_M", "0.04"))
    mirror = os.getenv("AURA_SOUND_MIRROR", "0") == "1"
    if not math.isfinite(front) or not math.isfinite(radius):
        raise ValueError("Sound front angle and array radius must be finite")
    return {
        "device": os.getenv("AURA_SOUND_DEVICE", "hw:MicArray,0"),
        "rate": 48000, "channels": 8, "mic_channels": list(range(6)),
        "radius_m": radius, "frame_size": 2048, "gate_dbfs": -35.0,
        "min_confidence": 0.55, "angle_offset_deg": front if mirror else -front,
        "mirror": mirror,
        "hold_seconds": 1.5, "vad_enabled": True, "vad_mode": 2,
        "vad_channel": 0, "asr_enabled": False,
    }


class DirectionAttention:
    """Require a dominant short-window cluster, not just a high per-frame score."""

    def __init__(self):
        self.samples = deque()
        self.angle = None
        self.last_target = -math.inf

    def update(self, result, now, suppressed=False):
        if suppressed:
            self.samples.clear()
            return
        while self.samples and now - self.samples[0][0] > 0.45:
            self.samples.popleft()
        angle = result.get("angle")
        if (result.get("active") and angle is not None
                and math.isfinite(angle) and result["confidence"] >= 0.55):
            self.samples.append((now, angle, result["confidence"]))
        if not result.get("active") or len(self.samples) < 5:
            return
        angles = np.array([sample[1] for sample in self.samples])
        distances = np.abs((angles[:, None] - angles[None, :] + 180) % 360 - 180)
        cluster = distances[np.argmax(np.sum(distances <= 20, axis=1))] <= 20
        if np.count_nonzero(cluster) < 5 or np.mean(cluster) < 0.65:
            return
        weights = np.array([sample[2] for sample in self.samples])[cluster]
        vector = np.sum(weights * np.exp(1j * np.deg2rad(angles[cluster]))) / weights.sum()
        if abs(vector) < 0.95:
            return
        self.angle = float(np.rad2deg(np.angle(vector)) % 360)
        self.last_target = [sample[0] for sample, selected in zip(self.samples, cluster) if selected][-1]


class PcmDecimator:
    """Streaming low-pass and 48 -> 16 kHz decimation, preserving block phase."""

    def __init__(self):
        taps = np.arange(97) - 48
        kernel = np.sinc(2 * 6500 / 48000 * taps) * np.hamming(97)
        self.kernel = kernel / kernel.sum()
        self.tail = np.zeros(96)
        self.offset = 0

    def process(self, samples):
        extended = np.concatenate((self.tail, samples.astype(np.float64)))
        filtered = np.convolve(extended, self.kernel, mode="valid")
        self.tail = extended[-96:]
        output = filtered[(-self.offset) % 3::3]
        self.offset += len(samples)
        return np.clip(np.rint(output), -32768, 32767).astype("<i2").tobytes()


class SoundDirectionService:
    def __init__(self, is_speaking):
        self.enabled = os.getenv("AURA_SOUND_LOCALIZATION", "0") == "1"
        self.is_speaking = is_speaking
        self.cfg = direction_config() if self.enabled else None
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.capture = None
        self.error = None
        self.updated = None
        self.latest = {}
        self.hold_during_playback = False
        self.attention = DirectionAttention()
        self.record_queue = None
        self.record_error = None
        self.capture_resyncs = 0
        self.dropped_blocks = 0

    def start(self):
        if self.enabled and self.thread is None:
            self.thread = threading.Thread(target=self._work, daemon=True, name="sound-direction")
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        with self.lock:
            if self.capture is not None:
                self.capture.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=5)
            if self.thread.is_alive():
                raise RuntimeError("Sound direction worker did not stop")

    def _work(self):
        capture = None
        try:
            pipeline = Pipeline(self.cfg)
            capture = Capture(self.cfg)
            with self.lock:
                self.capture = capture
            for pcm in capture.frames():
                if self.stop_event.is_set():
                    break
                if capture.resyncs != self.capture_resyncs:
                    # Direction/VAD history cannot span a gap; neither can an ASR phrase.
                    pipeline = Pipeline(self.cfg)
                    with self.lock:
                        self.capture_resyncs = capture.resyncs
                        self.dropped_blocks = capture.dropped_blocks
                        self.attention = DirectionAttention()
                        self.hold_during_playback = False
                        if self.record_queue is not None:
                            self.record_error = "麦克风处理短暂积压，本句录音已取消，请重新说话。"
                            LOGGER.warning("%s", self.record_error)
                result = pipeline.process(pcm)
                now = time.monotonic()
                suppressed = bool(self.is_speaking())
                with self.lock:
                    if suppressed and not self.latest.get("suppressed", False):
                        self.hold_during_playback = (
                            self.attention.angle is not None
                            and now - self.attention.last_target < 1.5
                        )
                    elif not suppressed:
                        self.hold_during_playback = False
                    self.attention.update(result, now, suppressed)
                    if suppressed and self.hold_during_playback:
                        self.attention.last_target = now
                    self.latest = {
                        "speech": bool(result["speech"]) and not suppressed,
                        "confidence": float(result["confidence"]),
                        "suppressed": suppressed,
                    }
                    self.updated = now
                    if self.record_queue is not None and not self.record_error:
                        try:
                            self.record_queue.put_nowait((
                                pcm[:, 0].copy(), result["speech_ratio"] >= 0.5,
                            ))
                        except queue.Full:
                            self.record_error = "Shared microphone consumer fell behind; please retry"
                            LOGGER.error("%s", self.record_error)
            if not self.stop_event.is_set():
                raise RuntimeError("Microphone stream ended unexpectedly")
        except (OSError, RuntimeError, ValueError, KeyError) as error:
            LOGGER.exception("Sound localization failed")
            with self.lock:
                self.error = str(error)
        finally:
            if capture is not None:
                capture.close()
            with self.lock:
                self.capture = None

    def snapshot(self):
        now = time.monotonic()
        with self.lock:
            stale = self.updated is not None and now - self.updated > 0.75
            ready = self.updated is not None and not stale and not self.error and not self.stop_event.is_set()
            tracking = bool(ready and self.attention.angle is not None
                            and now - self.attention.last_target < 1.5)
            angle = self.attention.angle if tracking else None
            return {
                "enabled": self.enabled, "ready": bool(ready),
                "angle_deg": angle,
                "yaw_deg": (angle + 180) % 360 - 180 if angle is not None else None,
                "tracking": tracking,
                "speech": bool(ready and self.latest.get("speech", False)),
                "confidence": self.latest.get("confidence", 0.0) if ready else 0.0,
                "suppressed": bool(ready and self.latest.get("suppressed", False)),
                "error": self.error or ("Microphone data is stale" if stale else None),
                "capture_resyncs": self.capture_resyncs,
                "dropped_blocks": self.dropped_blocks,
            }

    def record_phrase(self, *, wait_timeout=None, cancelled=None, on_speech=None):
        state = self.snapshot()
        if not state["ready"]:
            raise RuntimeError(state["error"] or "Microphone array is not ready")
        if self.is_speaking():
            raise RuntimeError("Wait until speech playback finishes before recording")
        frames = queue.Queue(maxsize=32)
        with self.lock:
            if self.record_queue is not None:
                raise RuntimeError("Shared microphone is already recording a phrase")
            self.record_error = None
            self.record_queue = frames
        pre = deque(maxlen=7)
        parts = []
        voiced = silent = 0
        recording = False
        decimator = PcmDecimator()
        deadline = time.monotonic() + (10 if wait_timeout is None else wait_timeout)
        phrase_deadline = None
        try:
            while True:
                if cancelled is not None and cancelled.is_set():
                    raise CancelledError()
                now = time.monotonic()
                if wait_timeout is None:
                    if now >= deadline:
                        break
                elif voiced >= 3840:
                    if now >= phrase_deadline:
                        break
                elif now >= deadline:
                    raise NoSpeechTimeout()
                state = self.snapshot()
                if not state["ready"]:
                    raise RuntimeError(state["error"] or "Microphone array stopped")
                with self.lock:
                    error = self.record_error
                if error:
                    raise RuntimeError(error)
                try:
                    mono, speech = frames.get(timeout=0.2)
                except queue.Empty:
                    continue
                data = decimator.process(mono)
                if not recording:
                    if not speech:
                        pre.append(data)
                        continue
                    parts.extend(pre)
                    recording = True
                    phrase_deadline = time.monotonic() + 10
                parts.append(data)
                if speech:
                    was_valid = voiced >= 3840
                    voiced += len(data) // 2
                    if not was_valid and voiced >= 3840 and on_speech is not None:
                        on_speech()
                    silent = 0
                else:
                    silent += len(data) // 2
                if silent >= 12800:
                    if voiced >= 3840:
                        break
                    pre.clear()
                    parts.clear()
                    voiced = silent = 0
                    recording = False
            if voiced < 3840:
                raise RuntimeError("No sufficiently long speech detected by the microphone array")
            return b"".join(parts)
        finally:
            with self.lock:
                self.record_queue = None
                self.record_error = None
