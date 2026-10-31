"""Consume camera events once, independently of WebSocket telemetry clients."""

import threading


class GestureVolumeController:
    def __init__(self, voice):
        self.voice = voice
        self.lock = threading.Lock()

    def handle(self, sample):
        if (sample.event, sample.command) not in (
            ("swipe_up", "vol_up"), ("swipe_down", "vol_down"),
        ):
            return
        with self.lock:
            volume = self.voice.adjust_volume(5 if sample.command == "vol_up" else -5)
            print(f"[GestureVolume] {sample.event}: AURA volume {volume}%")
