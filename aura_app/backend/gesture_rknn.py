"""Single-hand RK3576 inference for the OpenCV Zoo MediaPipe model pair."""

import hashlib
import json
import math
import os
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np


MODEL_DIRECTORY = Path(__file__).resolve().parent / "models" / "rknn"
PALM_SIZE = 192
HAND_SIZE = 224


def palm_anchors():
    anchors = []
    for grid, repeats in ((24, 2), (12, 6)):
        for y in range(grid):
            for x in range(grid):
                anchors.extend([((x + 0.5) / grid, (y + 0.5) / grid)] * repeats)
    return np.asarray(anchors, dtype=np.float32)


ANCHORS = palm_anchors()


def draw_landmarks(frame, result):
    height, width = frame.shape[:2]
    for hand in result.multi_hand_landmarks:
        points = [(round(point.x * width), round(point.y * height)) for point in hand.landmark]
        for chain in ((0, 1, 2, 3, 4), (0, 5, 6, 7, 8), (5, 9, 10, 11, 12),
                      (9, 13, 14, 15, 16), (13, 17, 18, 19, 20), (0, 17)):
            for start, end in zip(chain, chain[1:]):
                cv2.line(frame, points[start], points[end], (255, 0, 128), 2)
        for point in points:
            cv2.circle(frame, point, 3, (0, 255, 255), -1)


def checked_outputs(outputs, sizes, model):
    if not isinstance(outputs, (list, tuple)) or len(outputs) != len(sizes):
        raise RuntimeError(f"RKNN {model} output count mismatch; check the provisioned model bundle")
    arrays = []
    for index, (output, size) in enumerate(zip(outputs, sizes)):
        value = np.asarray(output)
        if value.size != size or not np.issubdtype(value.dtype, np.floating) or not np.isfinite(value).all():
            raise RuntimeError(f"RKNN {model} output {index} has invalid shape, dtype or values")
        arrays.append(value.reshape(-1))
    return arrays


def letterbox(frame):
    height, width = frame.shape[:2]
    scale = PALM_SIZE / max(width, height)
    resized = (max(1, round(width * scale)), max(1, round(height * scale)))
    left = (PALM_SIZE - resized[0]) // 2
    top = (PALM_SIZE - resized[1]) // 2
    image = cv2.resize(frame, resized)
    image = cv2.copyMakeBorder(image, top, PALM_SIZE - resized[1] - top,
                              left, PALM_SIZE - resized[0] - left, cv2.BORDER_CONSTANT)
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB), scale, np.array([left, top])


def decode_palm(outputs, scale, padding):
    boxes, logits = checked_outputs(outputs, (2016 * 18, 2016), "palm")
    # Only one hand is supported, so the highest scoring anchor needs no NMS.
    index = int(np.argmax(logits))
    score = 1 / (1 + math.exp(-float(np.clip(logits[index], -80, 80))))
    if score < 0.6:
        return None
    detection = boxes.reshape(2016, 18)[index]
    if np.any(detection[2:4] <= 0):
        raise RuntimeError("RKNN palm returned a non-positive bounding box")
    points = detection[4:].reshape(7, 2) + ANCHORS[index] * PALM_SIZE
    return (points - padding) / scale


def hand_crop(frame, palm):
    wrist, middle = palm[0], palm[2]
    direction = middle - wrist
    if np.linalg.norm(direction) < 1:
        raise RuntimeError("RKNN palm orientation is degenerate")
    # y points down in image coordinates; align wrist -> middle MCP with crop up.
    up = direction / np.linalg.norm(direction)
    right = np.array([-up[1], up[0]])
    axes = np.stack((right, -up))
    aligned = palm @ axes.T
    low, high = aligned.min(axis=0), aligned.max(axis=0)
    extent = high - low
    side = float(max(extent) * 3)
    if side < 2:
        raise RuntimeError("RKNN hand crop is too small")
    center = (low + high) / 2 + np.array([0, -0.4 * extent[1]])
    matrix = np.column_stack((axes * (HAND_SIZE / side),
                              (HAND_SIZE / 2 - center * HAND_SIZE / side)))
    crop = cv2.warpAffine(frame, matrix, (HAND_SIZE, HAND_SIZE))
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), cv2.invertAffineTransform(matrix), side


def decode_hand(outputs, inverse, side, width, height):
    landmarks, confidence, handedness, _world = checked_outputs(outputs, (63, 1, 1, 63), "hand")
    if not 0 <= confidence[0] <= 1 or not 0 <= handedness[0] <= 1:
        raise RuntimeError("RKNN hand confidence/handedness is not a probability")
    if confidence[0] < 0.8:
        return None
    points = landmarks.reshape(21, 3)
    xy = np.column_stack((points[:, :2], np.ones(21))) @ inverse.T
    return [SimpleNamespace(x=float(x / width), y=float(y / height),
                            z=float(z * side / HAND_SIZE / width))
            for (x, y), z in zip(xy, points[:, 2])]


class RknnHands:
    def __init__(self):
        self.models = []
        directory = Path(os.getenv("AURA_RKNN_MODEL_DIR", str(MODEL_DIRECTORY))).expanduser().resolve()
        manifest_path = directory / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, ValueError) as error:
            raise RuntimeError(
                f"Cannot read RKNN hand model manifest {manifest_path}; "
                "install a compatible RK3576 model bundle"
            ) from error
        if (not isinstance(manifest, dict) or manifest.get("format") != "aura-hand-rknn-v1"
                or manifest.get("target") != "rk3576"):
            raise RuntimeError("RKNN hand manifest must use aura-hand-rknn-v1 for rk3576")
        paths = []
        for name in ("palm", "hand"):
            entry = manifest.get(name)
            if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
                raise RuntimeError(f"RKNN hand manifest has no valid {name} model")
            path = (directory / entry["file"]).resolve()
            if path.parent != directory or path.suffix != ".rknn" or not path.is_file():
                raise RuntimeError(f"RKNN {name} model missing or outside model directory: {path}")
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry.get("sha256"):
                raise RuntimeError(f"RKNN {name} model checksum mismatch; reconvert the model pair")
            paths.append(path)
        try:
            from rknnlite.api import RKNNLite
        except ImportError as error:
            raise RuntimeError(
                "RKNN backend requires rknn-toolkit-lite2 from the repository root requirements.txt"
            ) from error
        try:
            for name, path in zip(("palm", "hand"), paths):
                runtime = RKNNLite()
                self.models.append(runtime)
                code = runtime.load_rknn(str(path))
                if code != 0:
                    raise RuntimeError(f"RKNN {name} model load failed (code {code})")
                code = runtime.init_runtime()
                if code != 0:
                    raise RuntimeError(f"RKNN {name} NPU initialization failed (code {code}); check driver/runtime versions")
        except Exception:
            self.close()
            raise

    def process(self, frame):
        if len(self.models) != 2:
            raise RuntimeError("RKNN hand backend is closed")
        if (not isinstance(frame, np.ndarray) or frame.dtype != np.uint8
                or frame.ndim != 3 or frame.shape[2] != 3 or min(frame.shape[:2]) < 1):
            raise ValueError("RKNN hands requires a non-empty uint8 BGR image")
        image, scale, padding = letterbox(frame)
        outputs = self.models[0].inference(inputs=[image[None]], data_format=["nhwc"])
        palm = decode_palm(outputs, scale, padding)
        hands = []
        if palm is not None:
            crop, inverse, side = hand_crop(frame, palm)
            outputs = self.models[1].inference(inputs=[crop[None]], data_format=["nhwc"])
            points = decode_hand(outputs, inverse, side, frame.shape[1], frame.shape[0])
            if points is not None:
                hands.append(SimpleNamespace(landmark=points))
        return SimpleNamespace(multi_hand_landmarks=hands)

    def close(self):
        models, self.models = self.models, []
        try:
            if models:
                models[0].release()
        finally:
            if len(models) > 1:
                models[1].release()
