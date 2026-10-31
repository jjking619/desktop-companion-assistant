"""Landmark-only vertical swipes adapted from Quectel's fingertip-motion path.

Source: demo-gesture-remote-control, src/gesture_recognizer.py,
commit 0ae238fa5ea8cb4426bd03c966d441a10165ab58 (see gesture_remote.py).
Retains pose/angle gates, hand-width normalization, EMA and down-path thresholds;
uses existing landmarks instead of optical flow, lighting correction or new Hands.
"""

from collections import deque
import math
import time


class LandmarkSwipeDetector:
    def __init__(self):
        self.locked = False
        self.release_started_at = None
        self.release_frame_at = None
        self.reset()

    def reset(self):
        self.previous = None
        self.last_frame_at = None
        self.motion = deque(maxlen=4)
        self.down_path = deque(maxlen=24)
        self.dy_ema = 0.0
        self.gate_high = False
        self.path = deque()

    def _release(self, released, now):
        if not self.locked:
            return
        if not released:
            self.release_started_at = None
            self.release_frame_at = None
            return
        if (self.release_frame_at is None or
                not 0 < now - self.release_frame_at < 0.4):
            self.release_started_at = now
        self.release_frame_at = now
        if now - self.release_started_at >= 0.3:
            self.locked = False
            self.release_started_at = None
            self.release_frame_at = None
            self.reset()

    def update(self, landmarks, width, height, *, now=None):
        now = time.monotonic() if now is None else now
        if landmarks is None:
            self._release(True, now)
            self.reset()
            return None
        if len(landmarks) != 21 or width <= 0 or height <= 0:
            raise ValueError("Swipe detection requires 21 landmarks and a positive frame size")
        points = [(p.x * width, p.y * height) for p in landmarks]
        if not all(math.isfinite(v) for point in points for v in point):
            raise ValueError("Swipe landmarks must be finite")
        tips = tuple(tip for tip, pip in ((8, 6), (12, 10), (16, 14), (20, 18))
                     if points[tip][1] < points[pip][1] - 10)
        self._release(8 not in tips, now)
        hand_width = abs(points[17][0] - points[5][0])
        if self.locked or tips != (8,) or hand_width < 1:
            self.reset()
            return None

        center = tuple(sum(points[i][axis] for i in (0, 5, 17)) / 3 for axis in (0, 1))
        current = (tips, points, center, (width, height))
        previous = self.previous
        elapsed = now - self.last_frame_at if self.last_frame_at is not None else None
        if (previous is None or elapsed <= 0 or elapsed >= 0.4
                or tips != previous[0] or (width, height) != previous[3]
                or math.hypot(center[0] - previous[2][0], center[1] - previous[2][1]) > 120):
            self.reset()
            self.previous = current
            self.last_frame_at = now
            self.path.append((now, points[8][1]))
            return None
        self.previous = current
        self.last_frame_at = now
        dx = points[8][0] - previous[1][8][0]
        dy = points[8][1] - previous[1][8][1]
        self.path.append((now, points[8][1]))
        while self.path and now - self.path[0][0] > 0.6:
            self.path.popleft()
        displacement = points[8][1] - self.path[0][1]
        distance_pass = abs(displacement) >= max(20, hand_width * 0.35) and displacement * dy > 0
        self.motion.append(dy)
        dy_norm = dy / (max(0.016, elapsed) * hand_width)
        self.dy_ema = 0.65 * self.dy_ema + 0.35 * dy_norm
        self.down_path.append((now, dy_norm))
        down_path_sum = sum(v for t, v in self.down_path if now - t <= 0.18 and v > 0)
        is_down = dy > 0
        angle_gate = 2.2 if is_down else 2.8
        margin_scale = 0.85 + 0.15 * min(1.0, max(0.0, height - center[1]) / 120)
        threshold = 1.40 * 0.82 * (0.90 * margin_scale if is_down else 1.0)
        if abs(self.dy_ema) <= threshold * 0.8 and down_path_sum <= 2.10 * 0.8:
            self.gate_high = False
        consistent = sum(v > 0 if is_down else v < 0 for v in self.motion) >= 3
        speed_pass = abs(self.dy_ema) > threshold
        path_pass = is_down and down_path_sum > 2.10
        if (not self.gate_high and consistent and distance_pass
                and abs(dy) > angle_gate * abs(dx) and dy * self.dy_ema > 0
                and (speed_pass or path_pass)):
            self.gate_high = True
            self.locked = True
            return "swipe_down" if is_down else "swipe_up"
        return None
