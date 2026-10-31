"""Offline WebRTC VAD gating, preserving all samples across 2048-frame blocks."""
import numpy as np
from .localization import Localizer


class SpeechDetector:
    def __init__(self, cfg, backend=None):
        self.cfg = cfg
        if backend is None:
            try:
                import webrtcvad
            except ImportError as exc:
                raise RuntimeError('WebRTC VAD missing. Install requirements/vad.txt as described in README') from exc
            backend = webrtcvad.Vad()
        self.backend = backend
        self.buffer = bytearray()
        self.positive_run = 0
        self.negative_run = 0
        self.speech = False
        self.mode = None

    def process(self, pcm):
        mode = int(self.cfg.get('vad_mode', 2))
        if self.mode != mode:
            self.backend.set_mode(mode)
            self.mode = mode
            self.buffer.clear()
            self.positive_run = self.negative_run = 0
            self.speech = False
        channel = int(self.cfg.get('vad_channel', 0))
        # A single raw channel avoids cancellation caused by averaging delayed signals.
        self.buffer.extend(np.ascontiguousarray(pcm[:, channel], dtype='<i2').tobytes())
        frame_bytes = self.cfg['rate']*20//1000*2
        decisions = []
        while len(self.buffer) >= frame_bytes:
            frame = bytes(self.buffer[:frame_bytes])
            del self.buffer[:frame_bytes]
            positive = bool(self.backend.is_speech(frame, self.cfg['rate']))
            decisions.append(positive)
            if positive:
                self.positive_run += 1
                self.negative_run = 0
                if self.positive_run >= 2:
                    self.speech = True
            else:
                self.positive_run = 0
                self.negative_run += 1
                if self.negative_run >= 10:
                    self.speech = False
        return {'speech': self.speech, 'speech_ratio': float(np.mean(decisions)) if decisions else 0.0}


class Pipeline:
    def __init__(self, cfg):
        self.cfg = cfg
        self.localizer = Localizer(cfg)
        self.detector = None
        if cfg.get('vad_enabled', False) or cfg.get('asr_enabled', False):
            self.detector = ArraySpeechDetector(cfg)

    def process(self, pcm):
        enabled = bool(self.cfg.get('vad_enabled', False))
        voice = {'speech': None, 'speech_ratio': 0.0}
        if enabled or self.cfg.get('asr_enabled', False):
            if self.detector is None:
                self.detector = ArraySpeechDetector(self.cfg)
            voice = self.detector.process(pcm)
        else:
            self.detector = None
        result = self.localizer.process(pcm,
            learn_noise=voice['speech'] is False and voice['speech_ratio'] == 0,
            suppress_noise=voice['speech'] is True)
        result.update(voice)
        floor = self.cfg.get('speech_floor_dbfs', -58.0)
        margin = self.cfg.get('speech_snr_db', 2.0)
        noise_db = result.get('noise_dbfs')
        adaptive_gate = max(floor, noise_db+margin) if noise_db is not None else floor
        effective_gate = min(self.cfg['gate_dbfs'], adaptive_gate)
        result['effective_gate_dbfs'] = effective_gate if enabled else self.cfg['gate_dbfs']
        audible = result['analysis_dbfs'] >= floor
        snr_ok = result['snr_db'] is None or result['snr_db'] >= 0
        # Sentence metadata has its own validity and never depends on the display gate.
        result['sentence_direction_valid'] = bool(voice['speech'] and audible and snr_ok
                                                  and result['direction_valid'])
        if enabled:
            result['active'] = bool(voice['speech'] and result['direction_valid'] and audible
                                   and result['analysis_dbfs'] >= effective_gate)
        result['vad_enabled'] = enabled
        return result


class ArraySpeechDetector:
    """Majority voting on three spaced raw microphones avoids a single bad channel."""
    def __init__(self, cfg):
        self.cfg = cfg
        indices = cfg['mic_channels']
        first = indices.index(cfg.get('vad_channel', 0))
        self.detectors = [SpeechDetector(dict(cfg, vad_channel=indices[(first+offset) % 6]))
                          for offset in (0, 2, 4)]

    def process(self, pcm):
        decisions = []
        for detector in self.detectors:
            detector.cfg['vad_mode'] = self.cfg.get('vad_mode', 2)
            decisions.append(detector.process(pcm))
        votes = sum(result['speech'] for result in decisions)
        return {'speech': votes >= 2,
                'speech_ratio': float(np.median([result['speech_ratio'] for result in decisions])),
                'speech_votes': votes}
