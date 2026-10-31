import os
import platform
import shutil
import subprocess
import threading
import time
import math
from pathlib import Path
import tempfile
import wave
import select
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass, replace
from collections.abc import Callable, Generator, Iterable

import numpy as np
from bailian import SpeechError, cloud_enabled, recognize, synthesize
from speech_timing import MouthCue, mouth_at, mouth_weights_at
from concurrent.futures import CancelledError

PLAYBACK_OUTPUT_LATENCY_SECONDS = 0.1

_SPEECH_BOUNDARY = re.compile(r"""[。！？!?]+[”’」』"'）)]*|(?<!\.)\.(?!\.)[”’」』"'）)]*(?=\s|$)|\n+""")


def _speech_parts(text, *, final):
    sentences = []
    start = 0
    for boundary in _SPEECH_BOUNDARY.finditer(text):
        end = boundary.end()
        if not final and end == len(text):
            break
        sentence = text[start:end].strip()
        if sentence:
            sentences.append(sentence)
        start = end
    if final and text[start:].strip():
        sentences.append(text[start:].strip())
        start = len(text)
    return sentences, text[start:]


def speech_sentences(text):
    return _speech_parts(text, final=True)[0]


def iter_speech_sentences(chunks: Iterable[str], cancelled: threading.Event,
                          on_text: Callable[[str], None] | None = None) -> Generator[str, None, None]:
    source = iter(chunks)
    buffer = ""
    try:
        for chunk in source:
            if cancelled.is_set():
                return
            if not isinstance(chunk, str):
                raise SpeechError("流式回复包含无效文字，已停止语音播放。")
            if on_text is not None:
                on_text(chunk)
            buffer += chunk
            sentences, buffer = _speech_parts(buffer, final=False)
            yield from sentences
        if not cancelled.is_set():
            yield from _speech_parts(buffer, final=True)[0]
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()


@dataclass
class PreparedSpeech:
    text: str
    pcm: bytes
    sample_rate: int
    channels: int
    cues: list[MouthCue] | None


def trim_speech_silence(audio: PreparedSpeech) -> PreparedSpeech:
    if (audio.channels not in (1, 2) or audio.sample_rate <= 0 or
            not audio.pcm or len(audio.pcm) % (2 * audio.channels)):
        raise SpeechError("语音合成返回了无效的 PCM 音频，无法调整停顿。")
    frames = np.frombuffer(audio.pcm, dtype="<i2").astype(np.int32).reshape(-1, audio.channels)
    audible = np.flatnonzero(np.max(np.abs(frames), axis=1) > 8)
    if not audible.size:
        raise SpeechError("语音合成返回了全静音音频，未开始播放。")
    first = max(0, int(audible[0]) - round(audio.sample_rate * 0.08))
    last = min(len(frames), int(audible[-1]) + 1 + round(audio.sample_rate * 0.18))
    if first == 0 and last == len(frames):
        return audio
    offset_ms = first * 1000 / audio.sample_rate
    end_ms = last * 1000 / audio.sample_rate
    cues = None if audio.cues is None else [
        replace(cue, start_ms=max(cue.start_ms, offset_ms) - offset_ms,
                end_ms=min(cue.end_ms, end_ms) - offset_ms)
        for cue in audio.cues if cue.end_ms > offset_ms and cue.start_ms < end_ms
    ]
    return replace(audio, pcm=audio.pcm[first * audio.channels * 2:last * audio.channels * 2], cues=cues)


class VoiceEngine:
    """
    Real-Time Voice Engine.
    Lazy-loads speech recognition and TTS engines on-demand to achieve sub-second backend server launch.
    """
    def __init__(self):
        self.recognizer = None
        self.audio_source = None
        self.engine = None
        self.is_speaking = False
        self.is_listening = False
        self.audio_level = 0.0
        self.viseme = None
        self.mouth_weights = None
        self.lip_sync_mode = "amplitude"
        self.speech_text = ""
        # On macOS pyttsx3 drives NSSpeechSynthesizer, which needs a runloop and
        # deadlocks when spoken from a worker thread. The `say` binary is the
        # supported path there, so prefer it whenever it is available.
        self._use_say = platform.system() == "Darwin" and shutil.which("say") is not None
        self.mac_voice = None
        self.last_error = None
        self.is_muted = False
        self._speech_lock = threading.Lock()
        self._process_lock = threading.Lock()
        self._playback = None
        self._speech_timeline = None
        self._cancel_speech = threading.Event()
        self.is_preparing = False
        self._speech_request_start = None
        self._segment_ended_at = None
        self.first_audio_latency_ms = None
        self.last_segment_gap_ms = None
        self.volume_control_enabled = os.getenv("AURA_GESTURE_VOLUME", "0") == "1"
        self.volume_percent = 100

    def adjust_volume(self, delta):
        if not self.volume_control_enabled or platform.system() != "Linux":
            raise RuntimeError("AURA speech volume control is not enabled for Linux")
        if delta not in (-5, 5):
            raise ValueError("AURA speech volume changes must be -5 or +5 percentage points")
        with self._process_lock:
            self.volume_percent = max(0, min(100, self.volume_percent + delta))
            return self.volume_percent

    @staticmethod
    def _scale_pcm(samples, volume_percent):
        return np.clip(samples * (volume_percent / 100), -32768, 32767).astype("<i2").tobytes()

    def _stream_pcm(self, playback, samples, sample_rate, channels, start, cancelled=None):
        if cancelled is None:
            cancelled = self._cancel_speech
        stream = playback.stdin
        os.set_blocking(stream.fileno(), False)
        chunk_size = max(1, int(sample_rate * 0.02)) * channels
        deadline = start + len(samples) / (sample_rate * channels) + 10
        try:
            for offset in range(0, len(samples), chunk_size):
                due = start + offset / (sample_rate * channels)
                while time.monotonic() < due:
                    if self.is_muted or cancelled.is_set():
                        return
                    if playback.poll() is not None:
                        raise RuntimeError("语音 PCM 播放器在音频发送完成前退出。")
                    time.sleep(min(0.01, max(0, due - time.monotonic())))
                with self._process_lock:
                    if self.is_muted or cancelled.is_set():
                        return
                    gain = self.volume_percent
                    self._update_playback_state()
                chunk = memoryview(self._scale_pcm(samples[offset:offset + chunk_size], gain))
                while chunk:
                    if self.is_muted or cancelled.is_set():
                        return
                    if playback.poll() is not None:
                        raise RuntimeError("语音 PCM 播放器在音频发送完成前退出。")
                    if time.monotonic() > deadline:
                        raise RuntimeError("语音 PCM 播放写入超时，请检查输出设备。")
                    if select.select([], [stream], [], 0.1)[1]:
                        try:
                            written = os.write(stream.fileno(), chunk[:4096])
                        except BlockingIOError:
                            continue
                        except BrokenPipeError:
                            if self.is_muted or cancelled.is_set():
                                return
                            raise
                        chunk = chunk[written:]
        finally:
            stream.close()
            playback.stdin = None

    def _update_playback_state(self):
        if self._speech_timeline is None:
            return
        samples, rate, cues, start = self._speech_timeline
        elapsed = time.monotonic() - start
        if elapsed < 0:
            self.viseme = None
            self.mouth_weights = mouth_weights_at(cues, elapsed * 1000) if cues is not None else None
            self.audio_level = 0.0
            return
        offset = int(elapsed * rate)
        self.viseme = mouth_at(cues, elapsed * 1000) if cues is not None else None
        self.mouth_weights = mouth_weights_at(cues, elapsed * 1000) if cues is not None else None
        chunk = samples[offset:offset + max(1, int(rate * 0.02))]
        self.audio_level = min(1.0, float(np.sqrt(np.mean(chunk ** 2))) / 8000) if chunk.size else 0.0

    def toggle_mute(self):
        with self._process_lock:
            self.is_muted = not self.is_muted
            if self.is_muted:
                self._stop_locked()
        return self.is_muted

    def _clear_speech_state(self):
        self.is_speaking = False
        self.is_preparing = False
        self.audio_level = 0.0
        self.viseme = None
        self.mouth_weights = None
        self.speech_text = ""
        self._speech_timeline = None

    def _stop_locked(self):
        self._cancel_speech.set()
        self._cancel_speech = threading.Event()
        if self._playback and self._playback.poll() is None:
            self._playback.terminate()
        self._clear_speech_state()

    def stop(self):
        with self._process_lock:
            self._stop_locked()
        if self.engine is not None:
            self.engine.stop()

    @staticmethod
    def _prepare_board_wav(path):
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            width = audio.getsampwidth()
            rate = audio.getframerate()
            frames = audio.readframes(audio.getnframes())
        if width != 2 or channels not in (1, 2):
            raise RuntimeError("板载扬声器需要 16bit 单声道或双声道 PCM 音频。")
        if channels == 2:
            return
        # ES8389 accepts mono but consumes it at twice the intended speed.
        # Duplicate samples into stereo without changing rate, pitch or duration.
        stereo = np.repeat(np.frombuffer(frames, dtype="<i2"), 2).tobytes()
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(2)
            audio.setsampwidth(width)
            audio.setframerate(rate)
            audio.writeframes(stereo)

    def _prepare_linux(self, text):
        local_root = Path.home() / ".local/opt/aura-espeak/usr"
        local_binary = local_root / "bin/espeak-ng"
        binary = str(local_binary) if local_binary.is_file() else shutil.which("espeak-ng")
        alsa_device = os.getenv("AURA_ALSA_DEVICE")
        player = shutil.which("aplay" if alsa_device else "paplay")
        if (not cloud_enabled() and not binary) or not player:
            raise RuntimeError("语音播放缺少 espeak-ng 或音频播放工具，请检查 README.md。")
        environment = os.environ.copy()
        if local_binary.is_file():
            library_path = str(local_root / "lib/aarch64-linux-gnu")
            environment["LD_LIBRARY_PATH"] = library_path + os.pathsep + environment.get("LD_LIBRARY_PATH", "")
            environment["ESPEAK_DATA_PATH"] = str(local_root / "lib/aarch64-linux-gnu/espeak-ng-data")
        with tempfile.TemporaryDirectory(prefix="aura-tts-") as directory:
            path = Path(directory) / "speech.wav"
            cues = None
            voice = os.getenv("AURA_TTS_VOICE", "cmn" if any("\u3400" <= c <= "\u9fff" for c in text) else "en")
            if cloud_enabled():
                cues = synthesize(text, path, with_timing=True)
            else:
                subprocess.run(
                    [binary, "-v", voice, "-s", "155", "-w", str(path), "--stdin"],
                    input=text, text=True, capture_output=True, check=True, timeout=30, env=environment,
                )
            if alsa_device == "plughw:CARD=rockchipes8389,DEV=0":
                self._prepare_board_wav(path)
            with wave.open(str(path), "rb") as audio:
                if audio.getsampwidth() != 2:
                    raise RuntimeError("语音合成返回了不支持的音频格式。")
                pcm = audio.readframes(audio.getnframes())
                sample_rate = audio.getframerate()
                channels = audio.getnchannels()
            return trim_speech_silence(PreparedSpeech(text, pcm, sample_rate, channels, cues))

    def _mark_playback_started(self, now):
        if self.first_audio_latency_ms is None and self._speech_request_start is not None:
            self.first_audio_latency_ms = round((now - self._speech_request_start) * 1000, 1)
        if self._segment_ended_at is not None:
            self.last_segment_gap_ms = round((now - self._segment_ended_at) * 1000, 1)

    def _play_linux(self, prepared, cancelled):
        alsa_device = os.getenv("AURA_ALSA_DEVICE")
        player = shutil.which("aplay" if alsa_device else "paplay")
        if not player:
            raise RuntimeError("缺少音频播放工具，请检查 README.md。")
        sample_rate, channels, cues = prepared.sample_rate, prepared.channels, prepared.cues
        samples = np.frombuffer(prepared.pcm, dtype="<i2").astype(np.float32)
        rate = sample_rate * channels
        with tempfile.TemporaryDirectory(prefix="aura-play-") as directory:
            path = Path(directory) / "speech.wav"
            with wave.open(str(path), "wb") as audio:
                audio.setparams((channels, 2, sample_rate, 0, "NONE", "not compressed"))
                audio.writeframes(prepared.pcm)
            command = [player]
            if alsa_device:
                command += ["-q", "-D", alsa_device, "--buffer-time=100000"]
            else:
                sink = os.getenv("AURA_AUDIO_SINK")
                if sink:
                    command += ["--device", sink]
                command += ["--latency-msec=100"]
            streaming = self.volume_control_enabled
            if streaming:
                if alsa_device:
                    command += ["-t", "raw", "-f", "S16_LE", "-r", str(sample_rate),
                                "-c", str(channels)]
                else:
                    command += ["--raw", "--format=s16le", f"--rate={sample_rate}",
                                f"--channels={channels}"]
            else:
                command.append(str(path))
            if alsa_device == "plughw:CARD=rockchipes8389,DEV=0" and not cancelled.is_set():
                subprocess.run(
                    ["amixer", "-c", "rockchipes8389", "sset", "spk switch", "on"],
                    capture_output=True, text=True, check=True, timeout=5,
                )
            with self._process_lock:
                if self.is_muted or cancelled.is_set():
                    return
                self._playback = subprocess.Popen(
                    command, stderr=subprocess.PIPE, text=True,
                    **({"stdin": subprocess.PIPE, "bufsize": 0} if streaming else {}),
                )
                playback = self._playback
                self.viseme = None
                self.mouth_weights = None
                self.lip_sync_mode = "word-timestamps" if cues is not None else "amplitude"
                self.is_preparing = False
                self.speech_text = prepared.text
                start = time.monotonic()
                self._mark_playback_started(start)
                # Both Linux playback paths request a 100 ms buffer; align cues to audible output.
                self._speech_timeline = (samples, rate, cues, start + PLAYBACK_OUTPUT_LATENCY_SECONDS)
                self.is_speaking = True
            try:
                if streaming:
                    self._stream_pcm(playback, samples, sample_rate, channels, start, cancelled)
                while playback.poll() is None:
                    with self._process_lock:
                        self._update_playback_state()
                    if time.monotonic() - start > len(samples) / rate + 10:
                        playback.terminate()
                        raise RuntimeError("音频播放超时，请检查音频输出设备。")
                    time.sleep(0.02)
                _, error = playback.communicate()
                if playback.returncode and not self.is_muted and not cancelled.is_set():
                    raise RuntimeError(f"音频播放失败：{error.strip()}")
            finally:
                if playback.poll() is None:
                    playback.terminate()
                if playback.stderr and not playback.stderr.closed:
                    playback.communicate()
                else:
                    playback.wait()
                with self._process_lock:
                    self._playback = None
                    self._segment_ended_at = time.monotonic()
                    self._clear_speech_state()

    def _speak_segments(self, sentences: Generator[str, None, None], cancelled, muted):
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="aura-sentence")
        pending = None
        linux = platform.system() == "Linux"

        def prepare_next():
            for sentence in sentences:
                if cancelled.is_set():
                    return None
                if not muted:
                    return self._prepare_linux(sentence) if linux else sentence
            return None

        try:
            pending = executor.submit(prepare_next)
            while pending is not None and not cancelled.is_set():
                with self._process_lock:
                    if cancelled.is_set():
                        return
                    self.is_preparing = True
                while not cancelled.is_set():
                    try:
                        prepared = pending.result(timeout=0.05)
                        break
                    except FutureTimeout:
                        if pending.done():
                            prepared = pending.result()
                            break
                else:
                    return
                if cancelled.is_set() or prepared is None:
                    return
                pending = executor.submit(prepare_next)
                if isinstance(prepared, PreparedSpeech):
                    self._play_linux(prepared, cancelled)
                else:
                    self._play_native(prepared, cancelled)
        finally:
            if pending is not None:
                pending.cancel()
                # Observe failures even when an in-flight cloud request finishes after stop.
                pending.add_done_callback(self._report_abandoned_synthesis)
            # Close generators on their owning worker, after any in-flight read finishes.
            cleanup = executor.submit(sentences.close)
            cleanup.add_done_callback(self._report_abandoned_synthesis)
            executor.shutdown(wait=False)

    @staticmethod
    def _report_abandoned_synthesis(future):
        if not future.cancelled() and future.exception() is not None:
            print(f"[VoiceEngine] Pending synthesis error: {future.exception()}")

    _VOICE_HINTS = (
        # Windows SAPI
        "Zira", "Hazel", "Aria", "Jenny", "Female",
        # macOS say
        "Tingting", "Meijia", "Sinji", "Samantha", "Ava", "Allison", "Karen",
    )

    def _ensure_tts(self):
        if self._use_say:
            if self.mac_voice is None:
                self.mac_voice = self._pick_mac_voice()
            return

        if self.engine is None:
            try:
                import pyttsx3
                self.engine = pyttsx3.init()
                voices = self.engine.getProperty('voices')
                for voice in voices:
                    if any(hint.lower() in voice.name.lower() for hint in self._VOICE_HINTS):
                        self.engine.setProperty('voice', voice.id)
                        break
                self.engine.setProperty('rate', 170)
            except Exception as e:
                print(f"[VoiceEngine] TTS init error: {e}")

    def _pick_mac_voice(self):
        """
        Resolves the voice used by `say`. Override with AURA_TTS_VOICE=<name>.
        """
        preferred = os.getenv("AURA_TTS_VOICE")
        if preferred:
            return preferred
        try:
            listing = subprocess.run(
                ["say", "-v", "?"], capture_output=True, text=True, timeout=5
            ).stdout
        except Exception:
            return None

        names = [line.split()[0] for line in listing.splitlines() if line.strip()]
        for hint in self._VOICE_HINTS:
            for name in names:
                if hint.lower() in name.lower():
                    return name
        return None

    def _say(self, text: str, cancelled):
        cmd = ["say"]
        if self.mac_voice:
            cmd += ["-v", self.mac_voice]
        cmd.append(text)
        with self._process_lock:
            if cancelled.is_set():
                return
            self._playback = subprocess.Popen(cmd)
            playback = self._playback
        try:
            playback.wait()
            if playback.returncode and not cancelled.is_set():
                raise RuntimeError(f"macOS speech playback failed: {playback.returncode}")
        finally:
            with self._process_lock:
                self._playback = None

    def speak(self, text: str):
        if not text:
            return
        return self.speak_stream((text,))[0]

    def _play_native(self, sentence, cancelled):
        self._ensure_tts()
        if not self._use_say and self.engine is None:
            raise RuntimeError("无法初始化语音引擎。")
        with self._process_lock:
            if cancelled.is_set():
                return
            self.is_preparing = False
            self.is_speaking = True
            self.speech_text = sentence
            self._mark_playback_started(time.monotonic())
        wave_thread = threading.Thread(target=self._animate_speech_wave, args=(cancelled,), daemon=True)
        wave_thread.start()
        try:
            if self._use_say:
                self._say(sentence, cancelled)
            else:
                self.engine.say(sentence)
                self.engine.runAndWait()
        finally:
            with self._process_lock:
                self.is_speaking = False
                self._segment_ended_at = time.monotonic()
            wave_thread.join()

    def speak_stream(self, chunks: Iterable[str], *,
                     on_text: Callable[[str], None] | None = None) -> tuple[threading.Thread, threading.Event]:
        with self._process_lock:
            cancelled = self._cancel_speech
        requested_at = time.monotonic()

        def _speak_thread():
            with self._speech_lock:
                with self._process_lock:
                    if cancelled.is_set():
                        close = getattr(chunks, "close", None)
                        if close is not None:
                            close()
                        return
                    self.last_error = None
                    self.is_preparing = True
                    self._speech_request_start = requested_at
                    self.first_audio_latency_ms = None
                    self.last_segment_gap_ms = None
                    self._segment_ended_at = None
                    muted = self.is_muted
                try:
                    self._speak_segments(iter_speech_sentences(chunks, cancelled, on_text), cancelled, muted)
                except (OSError, RuntimeError, subprocess.SubprocessError, wave.Error, EOFError) as error:
                    if not cancelled.is_set():
                        self.last_error = str(error)
                        print(f"[VoiceEngine] Speak error: {error}")
                finally:
                    with self._process_lock:
                        self._clear_speech_state()

        thread = threading.Thread(target=_speak_thread, daemon=True)
        thread.start()
        return thread, cancelled

    def _animate_speech_wave(self, cancelled):
        t = 0
        while self.is_speaking and not cancelled.is_set():
            self.audio_level = abs(math.sin(t * 0.3) * 0.7 + math.cos(t * 0.7) * 0.3)
            t += 1
            time.sleep(0.05)

    def listen_continuous(self, cancelled, on_phase) -> str:
        if cancelled.is_set():
            raise CancelledError()
        if self.audio_source is None or not cloud_enabled():
            raise SpeechError("连续对话第一版需要启用麦克风阵列声源服务并配置百炼语音。")
        if self.is_speaking:
            raise SpeechError("人物播放期间不能录音。")
        self.is_listening = True
        self.audio_level = 0.0
        try:
            try:
                pcm = self.audio_source.record_phrase(
                    wait_timeout=30, cancelled=cancelled, on_speech=lambda: on_phase("listening"),
                )
            except RuntimeError as error:
                raise SpeechError(str(error)) from error
            if cancelled.is_set():
                raise CancelledError()
            self.is_listening = False
            on_phase("recognizing")
            return recognize(pcm=pcm, cancelled=cancelled)
        finally:
            self.is_listening = False
            self.audio_level = 0.0

    def listen(self) -> str:
        self.is_listening = True
        self.audio_level = 0.5
        text_result = ""

        try:
            pcm = None
            if self.audio_source is not None:
                try:
                    pcm = self.audio_source.record_phrase()
                except RuntimeError as error:
                    raise SpeechError(str(error)) from error
            if cloud_enabled():
                self.last_error = None
                if self.is_speaking:
                    raise SpeechError("人物正在说话，请播放结束后再点击录音，避免扬声器回声。")
                return recognize(pcm=pcm) if pcm is not None else recognize()
            import speech_recognition as sr
            if self.recognizer is None:
                self.recognizer = sr.Recognizer()

            if pcm is not None:
                audio = sr.AudioData(pcm, 16000, 2)
            else:
                with sr.Microphone() as source:
                    print("[VoiceEngine] Listening for user speech...")
                    self.recognizer.adjust_for_ambient_noise(source, duration=0.4)
                    audio = self.recognizer.listen(source, timeout=4, phrase_time_limit=6)
            print("[VoiceEngine] Processing audio...")
            text_result = self.recognizer.recognize_google(audio)
            print(f"[VoiceEngine] Speech recognized: '{text_result}'")
        except SpeechError:
            raise
        except Exception as e:
            print(f"[VoiceEngine] STT Error: {e}")
        finally:
            self.is_listening = False
            self.audio_level = 0.0

        return text_result.lower() if text_result else ""

    def get_audio_state(self):
        with self._process_lock:
            self._update_playback_state()
            return self._audio_snapshot()

    def _audio_snapshot(self):
        return {
            "is_speaking": self.is_speaking,
            "is_listening": self.is_listening,
            "is_preparing": self.is_preparing,
            "first_audio_latency_ms": self.first_audio_latency_ms,
            "last_segment_gap_ms": self.last_segment_gap_ms,
            "audio_level": round(self.audio_level, 2),
            "viseme": self.viseme if self.is_speaking and not self.is_muted else None,
            "mouth_weights": self.mouth_weights if self.is_speaking and not self.is_muted else None,
            "lip_sync_mode": self.lip_sync_mode,
            "speech_text": self.speech_text if self.is_speaking else "",
            "error": self.last_error,
            "is_muted": self.is_muted,
            "volume_percent": self.volume_percent,
            "gesture_volume_enabled": self.volume_control_enabled,
        }
