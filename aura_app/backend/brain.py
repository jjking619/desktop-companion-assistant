import asyncio
import importlib.util
import time
import os
import threading
from typing import Dict, Any, Optional

from voice import VoiceEngine
from llm import LLMEngine
from bailian import SpeechError, cloud_enabled
from sound_direction import SoundDirectionService, NoSpeechTimeout


class AuraBrain:
    """
    Central Multimodal Brain for AURA.
    Orchestrates microphone direction, hand gestures, voice, and LLM dialogue.
    """
    def __init__(self):
        self.mood = "neutral"
        self.history = []
        self.is_listening = False
        self.gesture_volume_enabled = os.getenv("AURA_GESTURE_VOLUME", "0") == "1"
        self.gesture_actions = (
            os.getenv("AURA_GESTURE_ACTIONS", "1") == "1"
            and os.getenv("AURA_GESTURE_BACKEND", "legacy") == "legacy"
        )

        # Unified Perception Engine
        self.voice = VoiceEngine()
        self.sound_direction = SoundDirectionService(lambda: self.voice.is_speaking)
        if self.sound_direction.enabled:
            self.voice.audio_source = self.sound_direction
        self.llm = LLMEngine()
        self.gesture_volume = None
        if self.gesture_volume_enabled:
            from gesture_volume import GestureVolumeController
            self.gesture_volume = GestureVolumeController(self.voice)
        from camera import CameraManager
        self.camera_manager = CameraManager(
            on_gesture=self.gesture_volume.handle if self.gesture_volume else None,
        )

        # Sleep & Interaction State
        self.last_interaction_time = time.time()
        self.is_asleep = False
        self.current_gesture = "none"
        self._listening_lock = asyncio.Lock()
        self._turn_task = None
        self._turn_revision = 0
        self.conversation_active = False
        self.conversation_phase = "idle"
        self._conversation_cancel = None

        # Camera capture and inference start only while a preview is connected.
        print("[Desktop Companion Assistant] Gesture camera ready for on-demand preview; capture and recognition are stopped.")

    def get_realtime_telemetry(self) -> Dict[str, Any]:
        """
        Returns full real-time telemetry frame for WebSocket streaming to frontend.
        """
        perc = self.camera_manager.get_telemetry()
        detected_gesture = perc["gesture"]
        fps = perc["fps"]

        # Handle Gesture triggers directly in real-time loop
        if self.gesture_actions:
            self._handle_gesture_action(detected_gesture)

        audio_state = self.voice.get_audio_state()
        audio_state["conversation_active"] = self.conversation_active
        audio_state["conversation_phase"] = self.conversation_phase
        audio_state["dialogue_state"] = (
            "listening" if audio_state.get("is_listening") else
            "speaking" if audio_state["is_speaking"] else
            "thinking" if self._turn_task is not None or audio_state.get("is_preparing") else
            "idle"
        )

        return {
            "type": "telemetry",
            "mood": self.mood,
            "gesture": detected_gesture,
            "gesture_backend": perc.get("gesture_backend", "disabled"),
            "gesture_mode": perc.get("gesture_mode", "state"),
            "gesture_event": perc.get("gesture_event"),
            "swipe_locked": perc.get("swipe_locked", False),
            "perception_error": perc.get("perception_error"),
            "fps": fps,
            "is_asleep": self.is_asleep,
            "audio": audio_state,
            "sound_direction": self.sound_direction.snapshot(),
        }

    def _handle_gesture_action(self, gesture: str):
        """
        Executes instant real-time AR actions based on recognized hand gestures.
        """
        if gesture == self.current_gesture:
            return
        self.current_gesture = gesture

        if gesture == "shoosh":
            print("[Brain Gesture] Muting audio via Shoosh gesture!")
            if not self.voice.is_muted:
                self.voice.toggle_mute()
        elif gesture == "open_palm":
            print("[Brain Gesture] Open Palm gesture detected - waking the assistant")
            if self.is_asleep:
                self.is_asleep = False
                self.last_interaction_time = time.time()

    async def process_message(self, message: str, on_turn=None) -> Optional[Dict[str, Any]]:
        if message in ("STOP_SPEECH", "STOP_CONTINUOUS"):
            if self._conversation_cancel is not None:
                self._conversation_cancel.set()
                self.voice.stop()
                task = self._turn_task
                if task is not None:
                    if not task.cancelling():
                        task.cancel()
                    # The recording worker must release the shared microphone before a new turn.
                    await asyncio.shield(asyncio.gather(task, return_exceptions=True))
                return {"type": "response", "text": "已结束连续对话，可重新点击说话。",
                        "mood": self.mood, "action": None, "interrupted": True, "system": True}
            self.voice.stop()
            self._turn_revision += 1
            task = self._turn_task
            self._turn_task = None
            if task is not None:
                task.cancel()
            return self._interrupted_response()
        if message == "TOGGLE_MUTE":
            return await self._process_message(message)
        if not message:
            return None
        if self._turn_task is not None or self.voice.is_listening:
            return {"type": "response", "text": "正在处理对话，请先打断或等待本轮结束。",
                    "mood": self.mood, "action": None, "system": True}
        task = asyncio.current_task()
        revision = self._turn_revision
        self._turn_task = task
        try:
            if message == "START_CONTINUOUS":
                return await self._continuous_dialogue(on_turn)
            return await self._process_message(message)
        except asyncio.CancelledError:
            if revision != self._turn_revision:
                return self._interrupted_response()
            if self._turn_task is task:
                self.voice.stop()
            raise
        finally:
            if self._turn_task is task:
                self._turn_task = None

    async def _continuous_dialogue(self, on_turn):
        if not cloud_enabled() or self.voice.audio_source is None:
            raise SpeechError("连续对话第一版需要 AURA_PROVIDER=bailian 和 AURA_SOUND_LOCALIZATION=1；单次说话仍可使用。")
        if self.voice.is_muted:
            raise SpeechError("请先取消语音静音，再开始连续对话。")
        microphone = self.sound_direction.snapshot()
        if not microphone["ready"]:
            raise SpeechError(microphone["error"] or "麦克风阵列尚未就绪，请稍后重试。")
        cancelled = threading.Event()
        self._conversation_cancel = cancelled
        self.conversation_active = True
        loop = asyncio.get_running_loop()

        def phase_changed(phase):
            if not cancelled.is_set():
                self.conversation_phase = phase

        try:
            async with self._listening_lock:
                while not cancelled.is_set():
                    self.conversation_phase = "waiting"
                    recording = asyncio.create_task(asyncio.to_thread(
                        self.voice.listen_continuous, cancelled,
                        lambda phase: loop.call_soon_threadsafe(phase_changed, phase),
                    ))
                    try:
                        heard = await asyncio.shield(recording)
                    except asyncio.CancelledError:
                        cancelled.set()
                        await asyncio.gather(recording, return_exceptions=True)
                        raise
                    except NoSpeechTimeout:
                        return {"type": "response", "text": "30 秒未检测到有效语音，已结束连续对话。",
                                "mood": self.mood, "action": None, "system": True}
                    if cancelled.is_set():
                        break
                    if not heard.strip():
                        raise SpeechError("未识别出有效文字，已结束连续对话；请重试。")
                    self.conversation_phase = "replying"
                    response = await self._chat_reply(heard)
                    if cancelled.is_set():
                        break
                    if on_turn is not None:
                        await on_turn({"type": "conversation_turn", "text": response, "heard": heard})
                    if self.voice.is_muted:
                        raise SpeechError("当前语音已静音，已结束连续对话。")
                    self.conversation_phase = "cooldown"
                    # Do not subscribe to microphone frames containing the playback tail.
                    await asyncio.sleep(0.35)
        finally:
            cancelled.set()
            self.voice.stop()
            self.conversation_active = False
            self.conversation_phase = "idle"
            self._conversation_cancel = None

    def _interrupted_response(self):
        return {"type": "response", "text": "已打断，可重新点击说话。",
                "mood": self.mood, "action": None, "interrupted": True, "system": True}

    async def _chat_reply(self, prompt):
        history = [dict(entry) for entry in self.history]
        user_entry = {"role": "user", "content": prompt}
        assistant_entry = {"role": "assistant", "content": ""}
        self.history.extend([
            user_entry,
            assistant_entry,
        ])
        received = []
        transcript_lock = threading.Lock()

        def on_text(text):
            with transcript_lock:
                received.append(text)

        def record(note=""):
            with transcript_lock:
                text = "".join(received)
            if text.strip():
                assistant_entry["content"] = text + note
            else:
                self.history[:] = [entry for entry in self.history
                                   if entry is not user_entry and entry is not assistant_entry]
            return text

        try:
            thread, cancelled = self.voice.speak_stream(
                self.llm.stream_response(prompt, history), on_text=on_text,
            )
            await asyncio.to_thread(thread.join)
        except asyncio.CancelledError:
            record("\n[本轮回复被用户打断，未完整播放。]")
            raise
        if cancelled.is_set():
            record("\n[本轮语音已中止，未完整播放。]")
            return self._interrupted_response()["text"]
        if self.voice.last_error:
            record("\n[本轮生成或语音失败，回复未完整播放。]")
            raise SpeechError(self.voice.last_error)
        response_text = record()
        if not response_text.strip():
            raise SpeechError("模型返回了空回复，请重试。")
        return response_text

    async def _process_message(self, message: str) -> Optional[Dict[str, Any]]:
        """
        Processes incoming command messages from frontend or voice input.
        """
        if not message:
            return None

        # Reset sleep timer
        self.last_interaction_time = time.time()
        if self.is_asleep:
            self.is_asleep = False

        print(f"[AuraBrain] Processing Command: '{message}'")

        response_text = ""

        if message == "TEST_SPEECH":
            thread = self.voice.speak("你回来啦，今天过得怎么样？想聊点什么，我听着呢。")
            await asyncio.to_thread(thread.join)
            response_text = self.voice.last_error or (
                "当前已静音，请先取消静音。" if self.voice.is_muted else "测试语音播放完成，请确认扬声器声音。"
            )

        elif message == "LISTEN_COMMAND":
            if (not cloud_enabled() and not self.sound_direction.enabled
                    and importlib.util.find_spec("pyaudio") is None):
                return {
                    "type": "response",
                    "text": "语音识别尚未安装：缺少 PyAudio 和 PortAudio。请安装语音依赖或配置百炼语音。",
                    "system": True,
                    "mood": self.mood,
                    "action": None
                }
            if self._listening_lock.locked():
                return {"type": "response", "text": "正在处理语音对话，请等待当前一轮结束。",
                        "mood": self.mood, "action": None, "system": True}
            async with self._listening_lock:
                self.is_listening = True
                try:
                    heard_text = await asyncio.to_thread(self.voice.listen)
                finally:
                    self.is_listening = False
                if heard_text and cloud_enabled():
                    response_text = await self._chat_reply(heard_text)
                    return {"type": "response", "text": response_text,
                            "mood": self.mood, "action": None}

            if heard_text:
                return await self._process_message(heard_text)
            else:
                response_text = "I didn't hear anything."
                self.voice.speak(response_text)
                return {
                    "type": "response",
                    "text": response_text,
                    "system": message in ("TEST_SPEECH", "TOGGLE_MUTE") or "mute" in message.lower(),
                    "mood": self.mood,
                    "action": None
                }

        elif message == "TOGGLE_MUTE" or "mute" in message.lower():
            response_text = "已静音。" if self.voice.toggle_mute() else "已取消静音。"

        else:
            response_text = await self._chat_reply(message)

        return {
            "type": "response",
            "text": response_text,
            "mood": self.mood,
            "action": None
        }
