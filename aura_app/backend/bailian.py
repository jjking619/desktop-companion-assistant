import json
from concurrent.futures import CancelledError, ThreadPoolExecutor, TimeoutError as FutureTimeout
import base64
import binascii
import os
import re
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from xml.sax.saxutils import escape

from dotenv import load_dotenv


def _load_config():
    backend = Path(__file__).resolve().parent
    for path in (
        backend.parent.parent / ".env",
        backend / ".env",
        Path.home() / ".config/aura/bailian.env",
    ):
        load_dotenv(path, override=False)


_load_config()


class SpeechError(RuntimeError):
    pass


def cloud_enabled():
    provider = os.getenv("AURA_PROVIDER", "local")
    if provider not in ("local", "bailian"):
        raise SpeechError("AURA_PROVIDER 必须为 local 或 bailian。")
    return provider == "bailian"


def require_key():
    key = os.getenv("DASHSCOPE_API_KEY")
    if not key:
        raise SpeechError("未配置 DASHSCOPE_API_KEY，请在仓库根目录 .env 或 ~/.config/aura/bailian.env 中设置北京百炼 API Key，并重启桌面陪伴助手。")
    return key


def _sdk():
    import dashscope

    dashscope.api_key = require_key()
    dashscope.base_websocket_api_url = os.getenv(
        "AURA_BAILIAN_WS_URL", "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    )
    return dashscope


def _tts_failure(message, model, voice):
    header = {}
    if isinstance(message, dict):
        data = message
    elif isinstance(message, str):
        try:
            data = json.loads(message)
        except ValueError:
            data = None
    else:
        data = None
    if isinstance(data, dict) and isinstance(data.get("header"), dict):
        header = data["header"]
    code = header.get("error_code", "Unknown")
    detail = header.get("error_message", "No structured server diagnostic was returned.")
    diagnostic = f"TTS synthesis failed: {code}: {detail} (model={model}, voice={voice})"
    for name in ("DASHSCOPE_API_KEY", "OPENAI_API_KEY"):
        secret = os.getenv(name)
        if secret:
            diagnostic = diagnostic.replace(secret, "[redacted]")
    diagnostic = re.sub(r"\bsk-[A-Za-z0-9_-]+", "[redacted]", diagnostic)
    return diagnostic[:1200]


def synthesize(text, path, *, with_timing=False):
    _sdk()
    from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer, ResultCallback
    from dashscope.common.error import DashScopeException
    from websocket import WebSocketException

    complete = threading.Event()
    chunks = []
    sentences = {}
    errors = []
    model = os.getenv("AURA_TTS_MODEL", "cosyvoice-v3-plus")
    voice = os.getenv("AURA_BAILIAN_VOICE", "longanhuan")

    class Callback(ResultCallback):
        def on_data(self, data):
            chunks.append(data)

        def on_event(self, message):
            try:
                output = json.loads(message)["payload"]["output"]
                if output.get("type") == "sentence-end":
                    sentence = output["sentence"]
                    if not isinstance(sentence.get("index"), int):
                        raise ValueError("Invalid sentence index")
                    sentences[sentence["index"]] = sentence
            except (ValueError, KeyError, TypeError, AttributeError):
                errors.append("百炼返回了无效的口型时间戳事件。")

        def on_complete(self):
            complete.set()

        def on_error(self, message):
            errors.append(_tts_failure(message, model, voice))
            complete.set()

    synthesizer = None
    try:
        synthesizer = SpeechSynthesizer(
            model=model,
            voice=voice,
            format=AudioFormat.PCM_16000HZ_MONO_16BIT,
            **({"callback": Callback(), "additional_params": {"word_timestamp_enabled": True}}
               if with_timing else {}),
        )
        audio = synthesizer.call(escape(text), timeout_millis=25000)
        if with_timing:
            if not complete.wait(25):
                raise SpeechError("带时间戳的语音合成超时，未开始播放。")
            if errors:
                raise SpeechError(errors[0])
            audio = b"".join(chunks)
    except (DashScopeException, WebSocketException, OSError, TimeoutError) as error:
        diagnostic = _tts_failure({"header": {
            "error_code": getattr(error, "name", None) or type(error).__name__,
            "error_message": getattr(error, "message", None) or
                "Check the connection, credentials, quota, model and voice configuration.",
        }}, model, voice)
        raise SpeechError(diagnostic) from error
    finally:
        if with_timing and synthesizer is not None:
            synthesizer.close()
    if not isinstance(audio, bytes) or not audio or len(audio) % 2:
        raise SpeechError("百炼未返回有效的 16bit PCM 音频，无法播放或驱动嘴型。")
    cues = None
    if with_timing:
        from speech_timing import build_mouth_cues, SpeechTimingError
        try:
            cues = build_mouth_cues([sentences[index] for index in sorted(sentences)], len(audio) / 32)
        except SpeechTimingError as error:
            raise SpeechError(str(error)) from error
    # Cloud streaming WAV headers may declare unknown lengths; build a finite WAV
    # from PCM so playback duration and amplitude indexing use actual frame counts.
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(audio)
    return cues


def _recognition_options():
    model = os.getenv("AURA_ASR_MODEL", "paraformer-realtime-v2")
    configured = os.getenv("AURA_ASR_LANGUAGES")
    if model != "paraformer-realtime-v2":
        if configured is not None:
            raise SpeechError("AURA_ASR_LANGUAGES 仅支持 paraformer-realtime-v2，请检查 ASR 模型配置。")
        return {"model": model}
    languages = [value.strip() for value in (configured if configured is not None else "en,zh").split(",")]
    supported = {"zh", "en", "ja", "ko", "de", "fr", "ru"}
    if not languages or any(value not in supported for value in languages):
        raise SpeechError("AURA_ASR_LANGUAGES 必须为逗号分隔的语种代码：en,zh,ja,ko,de,fr,ru。")
    return {"model": model, "language_hints": languages}


def _recognize_microphone(pcm=None):
    _sdk()
    from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult
    from dashscope.common.error import InvalidParameter

    complete = threading.Event()
    sentences = {}
    errors = []

    class Callback(RecognitionCallback):
        def on_event(self, result):
            sentence = result.get_sentence()
            if sentence and RecognitionResult.is_sentence_end(sentence):
                sentences[sentence.get("sentence_id", len(sentences))] = sentence.get("text", "")
                complete.set()

        def on_error(self, result):
            errors.append("百炼语音识别请求失败，请检查 API Key、余额、ASR 模型及服务地址。")
            complete.set()

    recognizer = Recognition(
        **_recognition_options(),
        callback=Callback(), format="pcm", sample_rate=16000,
    )
    if pcm is not None:
        if not pcm or len(pcm) % 2 or len(pcm) > 12 * 16000 * 2:
            raise SpeechError("阵列音频必须为不超过 12 秒的单通道 16 kHz / 16 bit PCM。")
        started = False
        try:
            recognizer.start()
            started = True
            for offset in range(0, len(pcm), 3200):
                if complete.is_set():
                    break
                recognizer.send_audio_frame(pcm[offset:offset + 3200])
        finally:
            if started:
                try:
                    recognizer.stop()
                except InvalidParameter:
                    if not errors:
                        raise SpeechError("阵列语音识别会话异常结束。")
        if errors:
            raise SpeechError(errors[0])
        if not sentences:
            raise SpeechError(
                f"阵列音频未返回识别文字（{len(pcm) / 32000:.2f} 秒 PCM，"
                f"ASR={recognizer.model}）；请检查录音是否包含完整人声、麦克风和识别语种。"
            )
        return "".join(sentences.values()).strip()
    command = [
        "arecord", "-q", "-D", os.getenv("AURA_MIC_DEVICE", "default"),
        "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1",
    ]
    with tempfile.TemporaryFile() as diagnostics:
        recorder = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=diagnostics)
        started = False
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(recorder.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=3):
                    raise SpeechError("麦克风没有返回音频，请检查系统输入设备及 AURA_MIC_DEVICE。")
                first_frame = os.read(recorder.stdout.fileno(), 1600)
                if not first_frame:
                    raise SpeechError(
                        f"无法打开麦克风 {os.getenv('AURA_MIC_DEVICE', 'default')}，"
                        "请检查设备是否已拔出、被占用或没有录音权限。"
                    )
                recognizer.start()
                started = True
                recognizer.send_audio_frame(first_frame)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not complete.is_set():
                    if not selector.select(timeout=0.1):
                        continue
                    data = os.read(recorder.stdout.fileno(), 1600)
                    if not data:
                        if recorder.poll() not in (None, 0):
                            raise SpeechError("无法录制麦克风，请检查 AURA_MIC_DEVICE 和录音设备占用。")
                        break
                    recognizer.send_audio_frame(data)
        finally:
            if recorder.poll() is None:
                recorder.terminate()
            try:
                recorder.wait(timeout=3)
            except subprocess.TimeoutExpired:
                recorder.kill()
                recorder.wait()
            recorder.stdout.close()
            if started:
                try:
                    recognizer.stop()
                except InvalidParameter:
                    if not errors:
                        raise SpeechError("百炼语音识别会话异常结束。")
    if errors:
        raise SpeechError(errors[0])
    return "".join(sentences.values()).strip()


def recognize(pcm=None, *, cancelled=None):
    if cancelled is not None and cancelled.is_set():
        raise CancelledError()
    require_key()
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()),
         "--recognize-pcm" if pcm is not None else "--recognize"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
        **({"stdin": subprocess.PIPE} if pcm is not None else {}),
    )
    try:
        payload = base64.b64encode(pcm).decode("ascii") if pcm is not None else None
        if cancelled is None:
            output, _ = process.communicate(input=payload, timeout=40)
        else:
            # Keep one communicate call writing stdin until EOF; timed retries can
            # abandon a partially written PCM payload while the child waits for it.
            with ThreadPoolExecutor(max_workers=1) as executor:
                transfer = executor.submit(process.communicate, input=payload, timeout=40)
                try:
                    while True:
                        if cancelled.is_set():
                            raise CancelledError()
                        try:
                            output, _ = transfer.result(timeout=0.1)
                            break
                        except FutureTimeout:
                            continue
                except CancelledError:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        transfer.result(timeout=3)
                    except (FutureTimeout, subprocess.TimeoutExpired):
                        os.killpg(process.pid, signal.SIGKILL)
                    raise
    except (subprocess.TimeoutExpired, CancelledError) as error:
        if not isinstance(error, CancelledError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        if isinstance(error, CancelledError):
            raise
        raise SpeechError("百炼录音/识别超时，请检查麦克风和网络后重试。") from error
    if cancelled is not None and cancelled.is_set():
        raise CancelledError()
    try:
        data = json.loads(output)
        if process.returncode:
            if isinstance(data.get("error"), str) and data["error"]:
                raise SpeechError(data["error"])
            raise ValueError("missing error")
        if not isinstance(data.get("text"), str):
            raise ValueError("missing text")
        return data["text"]
    except (ValueError, AttributeError) as error:
        message = ("百炼录音/识别失败，请检查麦克风、Key、ASR 模型及网络。"
                   if process.returncode else "百炼识别进程返回了无效结果。")
        raise SpeechError(message) from error


if __name__ == "__main__":
    if sys.argv[1:] not in (["--recognize"], ["--recognize-pcm"]):
        raise SystemExit("Usage: bailian.py --recognize | --recognize-pcm")
    try:
        pcm = None
        if sys.argv[1:] == ["--recognize-pcm"]:
            try:
                encoded = sys.stdin.read(512001)
                if len(encoded) > 512000:
                    raise ValueError("PCM input too long")
                pcm = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise SpeechError("阵列音频输入格式无效。") from error
        print(json.dumps({"text": _recognize_microphone(pcm)}, ensure_ascii=False))
    except SpeechError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
