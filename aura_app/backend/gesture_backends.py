"""Selectable hand pipelines; the remote backend emits events, not held poses."""

from collections import deque
from dataclasses import dataclass

import cv2

from gestures import classify_landmarks, most_frequent


BACKENDS = ("legacy", "remote", "rknn")


@dataclass(frozen=True)
class GestureSample:
    gesture: str
    hand_present: bool
    num_hands: int
    event: str | None = None
    command: str | None = None
    swipe_locked: bool = False


class GesturePipeline:
    def __init__(self, backend="legacy", *, enable_swipes=False):
        if backend not in BACKENDS:
            raise ValueError(f"Unknown gesture backend {backend!r}; choose {BACKENDS}")
        self.backend = backend
        self.previous = "none"
        self.history = deque(maxlen=5)
        self.remote = None
        self.swipes = None
        if enable_swipes:
            from gesture_swipe import LandmarkSwipeDetector
            self.swipes = LandmarkSwipeDetector()
        if backend == "remote":
            from gesture_remote import MediaPipeGestureRecognizer
            self.remote = MediaPipeGestureRecognizer()
            self.hands = self.remote.hands
        else:
            if backend == "rknn":
                from gesture_rknn import RknnHands
                self.hands = RknnHands()
            else:
                import mediapipe as mp
                self.hands = mp.solutions.hands.Hands(
                    static_image_mode=False, max_num_hands=1,
                    min_detection_confidence=0.6, min_tracking_confidence=0.5,
                )

    def process_frame(self, frame):
        if self.remote is not None:
            detection, result = self.remote.process_frame(frame)
            event = detection["gesture"]
            command = detection["cmd"]
            if self.swipes is not None:
                hands = result.multi_hand_landmarks if result else []
                swipe = self.swipes.update(
                    hands[0].landmark if len(hands) == 1 else None,
                    frame.shape[1], frame.shape[0],
                )
                if event in ("swipe_up", "swipe_down"):
                    event, command = None, None
                if swipe:
                    event = swipe
                    command = "vol_up" if swipe == "swipe_up" else "vol_down"
            return GestureSample(
                gesture=event or "none",
                hand_present=detection["hand_present"],
                num_hands=detection["num_hands"],
                event=event,
                command=command,
                swipe_locked=self.swipes.locked if self.swipes else False,
            ), result

        result = self.hands.process(frame if self.backend == "rknn" else cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        hands = result.multi_hand_landmarks or []
        raw = classify_landmarks(hands[0].landmark) if hands else "none"
        self.history.append(raw)
        gesture = most_frequent(self.history, fallback="none")
        event = gesture if gesture != "none" and gesture != self.previous else None
        self.previous = gesture
        command = None
        if self.swipes is not None:
            swipe = self.swipes.update(
                hands[0].landmark if hands else None, frame.shape[1], frame.shape[0],
            )
            if swipe:
                event = swipe
                command = "vol_up" if swipe == "swipe_up" else "vol_down"
        return GestureSample(gesture, bool(hands), len(hands), event, command,
                             self.swipes.locked if self.swipes else False), result

    def close(self):
        if self.remote is not None:
            self.remote.close()
        else:
            self.hands.close()
