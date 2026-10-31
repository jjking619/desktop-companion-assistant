import cv2
import os
import threading
import time
from contextlib import contextmanager
from gesture_backends import BACKENDS, GesturePipeline


class CameraManager:
    """
    Unified Camera & Perception Engine.
    Runs a single background thread. Lazy-imports MediaPipe inside background thread
    so main backend server starts in under 0.5 seconds.
    """

    def __init__(self, camera_index=0, on_gesture=None):
        source = os.getenv("AURA_CAMERA", str(camera_index))
        self.camera_index = int(source) if source.isdecimal() else source
        self.cap = None
        self.is_running = False
        self.thread = None
        self.lock = threading.Lock()
        self.lifecycle_lock = threading.RLock()

        # Latest Perception States
        self.current_gesture = "none"
        self.latest_frame_jpeg = None
        self.preview_clients = 0
        self.fps = 0.0
        self.gesture_backend = os.getenv("AURA_GESTURE_BACKEND", "legacy")
        self.gesture_swipes = os.getenv("AURA_GESTURE_VOLUME", "0") == "1"
        if self.gesture_backend not in BACKENDS:
            raise ValueError(f"AURA_GESTURE_BACKEND must be one of {BACKENDS}")
        self.gesture_pipeline = None
        self.gesture_event = None
        self.swipe_locked = False
        self.gesture_event_id = 0
        self.perception_error = None
        self.on_gesture = on_gesture

        self.mp_hands = None
        self.mp_drawing = None

    def start(self):
        if self.is_running:
            return
        if self.thread and self.thread.is_alive():
            raise RuntimeError("Previous camera thread is still stopping")
        self.is_running = True
        self.perception_error = None
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()
        print("[CameraManager] Perception Engine daemon thread started.")

    def stop(self):
        self.is_running = False
        if self.thread:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError("Camera thread did not stop within 15 seconds")
        with self.lock:
            self.current_gesture = "none"
            self.gesture_event = None
            self.swipe_locked = False
            self.latest_frame_jpeg = None
            self.fps = 0.0
        print("[CameraManager] Perception Engine stopped.")

    def _open_capture(self):
        """
        Opens the Linux V4L2 webcam.
        """
        return cv2.VideoCapture(self.camera_index, cv2.CAP_V4L2)

    def _capture_loop(self):
        try:
            self._run_capture()
        except Exception as error:
            with self.lock:
                self.perception_error = str(error)
            print(f"[CameraManager] Perception failed: {error}")
        finally:
            self.is_running = False
            try:
                if self.gesture_pipeline:
                    self.gesture_pipeline.close()
            finally:
                if self.cap:
                    self.cap.release()
                self.cap = None
                self.gesture_pipeline = None

    def _run_capture(self):
        # Lazy import MediaPipe inside background thread
        try:
            if self.gesture_backend != "rknn" and (self.mp_hands is None or self.mp_drawing is None):
                print("[CameraManager] Background thread loading MediaPipe modules...")
                import mediapipe as mp
                self.mp_hands = mp.solutions.hands
                self.mp_drawing = mp.solutions.drawing_utils

            # Module references survive preview shutdown; the released model does not.
            self.gesture_pipeline = GesturePipeline(
                self.gesture_backend, enable_swipes=self.gesture_swipes,
            )
            print(f"[CameraManager] {self.gesture_backend} hand model loaded in background.")
        except Exception as e:
            print(f"[CameraManager] Error initializing {self.gesture_backend} models: {e}")
            self.perception_error = str(e)
            self.is_running = False
            return

        if not self.is_running:
            return
        try:
            self.cap = self._open_capture()
            if not self.cap or not self.cap.isOpened():
                # Fall back to OpenCV's default backend before giving up
                if self.cap:
                    self.cap.release()
                    self.cap = None
                self.cap = cv2.VideoCapture(self.camera_index)
            if not self.cap or not self.cap.isOpened():
                print(f"[CameraManager] Camera {self.camera_index} unavailable. "
                      "Check device permissions and AURA_CAMERA.")
                self.perception_error = f"Camera {self.camera_index} unavailable"
            else:
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                print(f"[CameraManager] Camera {self.camera_index} opened with V4L2.")
        except Exception as e:
            print(f"[CameraManager] Camera open error: {e}")
            self.perception_error = str(e)

        if self.perception_error:
            return
        frame_count = 0
        start_time = time.time()
        self._process_frames(frame_count, start_time)

    def _process_frames(self, frame_count, start_time):
        next_frame_at = 0.0
        last_frame_at = time.monotonic()
        while self.is_running:
            if not self.cap or not self.cap.isOpened():
                raise RuntimeError("Camera disconnected or capture device closed")

            success, frame = self.cap.read()
            if not success or frame is None:
                if time.monotonic() - last_frame_at >= 4:
                    raise RuntimeError("Camera returned no frames for 4 seconds; check USB connection and AURA_CAMERA")
                time.sleep(0.03)
                continue
            last_frame_at = time.monotonic()

            # Keep draining capture frames so inference uses a recent image.
            now = time.monotonic()
            if now < next_frame_at:
                continue
            next_frame_at = now + 1 / 15
            with self.lock:
                preview_enabled = self.preview_clients > 0

            # Calculate FPS
            frame_count += 1
            elapsed = time.time() - start_time
            if elapsed >= 1.0:
                self.fps = round(frame_count / elapsed, 1)
                frame_count = 0
                start_time = time.time()

            sample, hand_results = self.gesture_pipeline.process_frame(frame)

            if preview_enabled and hand_results:
                if hand_results.multi_hand_landmarks:
                    if self.gesture_backend == "rknn":
                        from gesture_rknn import draw_landmarks
                        draw_landmarks(frame, hand_results)
                    else:
                        for landmarks in hand_results.multi_hand_landmarks:
                            self.mp_drawing.draw_landmarks(
                                frame, landmarks, self.mp_hands.HAND_CONNECTIONS,
                                self.mp_drawing.DrawingSpec(color=(255, 0, 128), thickness=2),
                                self.mp_drawing.DrawingSpec(color=(0, 255, 255), thickness=1)
                            )

            jpeg_bytes = None
            if preview_enabled:
                cv2.putText(frame, f"COMPANION GESTURE | FPS: {self.fps}", (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                cv2.putText(frame, f"Gesture: {sample.gesture.upper()}", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 100, 0), 2)
                encoded, jpeg_buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                if not encoded:
                    raise RuntimeError("Camera preview JPEG encoding failed")
                jpeg_bytes = jpeg_buffer.tobytes()

            with self.lock:
                self.current_gesture = sample.gesture
                self.swipe_locked = sample.swipe_locked
                if sample.event:
                    self.gesture_event_id += 1
                    self.gesture_event = {
                        "id": self.gesture_event_id,
                        "gesture": sample.event,
                        "command": sample.command,
                    }
                self.latest_frame_jpeg = jpeg_bytes if self.preview_clients else None

            if sample.event and self.on_gesture is not None:
                self.on_gesture(sample)

    def get_telemetry(self):
        with self.lock:
            return {
                "gesture": self.current_gesture,
                "fps": self.fps,
                "gesture_backend": self.gesture_backend,
                "gesture_mode": (
                    "event" if self.gesture_backend == "remote" else
                    "state+event" if self.gesture_swipes else "state"
                ),
                "gesture_event": self.gesture_event,
                "swipe_locked": self.swipe_locked,
                "perception_error": self.perception_error,
            }

    def get_frame_jpeg(self):
        with self.lock:
            return self.latest_frame_jpeg

    @contextmanager
    def preview(self):
        with self.lifecycle_lock:
            if not self.preview_clients or (self.perception_error and not self.is_running):
                self.start()
            with self.lock:
                self.preview_clients += 1
        try:
            yield
        finally:
            with self.lifecycle_lock:
                with self.lock:
                    self.preview_clients -= 1
                if not self.preview_clients:
                    self.stop()
