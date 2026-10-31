"""Six-microphone SRP GCC-PHAT; angles clockwise from MIC0 (top).

CH6 is deliberately excluded: MA-USB8 overwrites it with beamformed audio.
"""
import itertools
import numpy as np


def validate(cfg):
    if cfg['rate'] != 48000 or cfg['channels'] != 8:
        raise ValueError('MA-USB8 requires 48000 Hz / 8 channels')
    indices = cfg['mic_channels']
    if len(indices) != 6 or len(set(indices)) != 6 or any(i not in range(8) for i in indices):
        raise ValueError('mic_channels must contain six distinct channel indices in 0..7')
    if 6 in indices:
        raise ValueError('CH6 is beamformed audio and cannot be used as a raw localization channel')
    if not 0.01 <= cfg['radius_m'] <= 0.15:
        raise ValueError('radius_m must be in 0.01..0.15 meters')
    n = cfg['frame_size']
    if n < 512 or n > 8192 or n & (n - 1):
        raise ValueError('frame_size must be a power of two in 512..8192')
    if not 0 <= cfg['min_confidence'] <= 1 or cfg['hold_seconds'] < 0:
        raise ValueError('Invalid confidence or hold duration')
    if cfg.get('vad_mode', 2) not in (0, 1, 2, 3):
        raise ValueError('vad_mode must be in 0..3; higher values are stricter')
    if cfg.get('vad_channel', 0) not in indices:
        raise ValueError('vad_channel must select a raw outer microphone')
    if not -80 <= cfg.get('speech_floor_dbfs', -58.0) <= -20:
        raise ValueError('speech_floor_dbfs must be in -80..-20')
    if not 0 <= cfg.get('speech_snr_db', 2.0) <= 15:
        raise ValueError('speech_snr_db must be in 0..15')


class Localizer:
    def __init__(self, cfg):
        validate(cfg)
        self.cfg = cfg
        self.n = cfg['frame_size']
        self.fft_size = 2 * self.n
        self.window = np.hanning(self.n)[:, None]
        angles = np.arange(6) * np.pi / 3
        self.positions = cfg['radius_m'] * np.column_stack((np.sin(angles), np.cos(angles)))
        self.angles = np.arange(0, 360, 2)
        radians = np.deg2rad(self.angles)
        direction = np.column_stack((np.sin(radians), np.cos(radians)))
        self.pairs = list(itertools.combinations(range(6), 2))
        # For source u: arrival time t_i = -p_i dot u / c.
        self.lags = np.array([-(self.positions[i] - self.positions[j]) @ direction.T
                              * cfg['rate'] / 343.0 for i, j in self.pairs])
        self.freq_mask = (np.fft.rfftfreq(self.fft_size, 1/cfg['rate']) >= 250)
        self.freq_mask &= np.fft.rfftfreq(self.fft_size, 1/cfg['rate']) <= 4000
        self.noise_power = None
        self.noise_frames = 0

    def process(self, pcm, *, learn_noise=False, suppress_noise=False):
        x = pcm[:, self.cfg['mic_channels']].astype(np.float64) / 32768.0
        rms = np.sqrt(np.mean(x*x, axis=0))
        db = float(20*np.log10(max(float(np.sqrt(np.mean(x*x))), 1e-9)))
        result = {'dbfs': db, 'rms': rms.tolist(), 'angle': None,
                  'confidence': 0.0, 'active': False, 'direction_valid': False,
                  'analysis_dbfs': db, 'noise_dbfs': None, 'snr_db': None,
                  'scores': [0.0]*180}
        # A manual display threshold must not prevent direction estimation for ASR.
        if db < -75 or np.count_nonzero(rms > 1e-6) < 4:
            return result
        x -= x.mean(axis=0)
        spectrum = np.fft.rfft(x*self.window, n=self.fft_size, axis=0)
        power = np.mean(np.abs(spectrum)**2, axis=1)
        if learn_noise:
            if self.noise_power is None:
                self.noise_power = power.copy()
            else:
                self.noise_power = 0.96*self.noise_power+0.04*power
            self.noise_frames += 1
        weights = self.freq_mask.astype(float)
        calibrated = self.noise_power is not None and self.noise_frames >= 3
        if suppress_noise and calibrated:
            # Downweight stable fan/hum bins using only non-speech observations.
            excess = np.clip(1-self.noise_power/np.maximum(power, 1e-15), 0, 1)
            weights *= np.sqrt(excess)
        normalization = self.fft_size*float(np.sum(self.window**2))
        signal_power = float(2*np.sum(power*weights**2)/normalization)
        analysis_db = float(10*np.log10(max(signal_power, 1e-18)))
        result['analysis_dbfs'] = analysis_db
        if calibrated:
            noise_power = float(2*np.sum(self.noise_power*weights**2)/normalization)
            noise_db = float(10*np.log10(max(noise_power, 1e-18)))
            result.update(noise_dbfs=noise_db, snr_db=analysis_db-noise_db)
        scores = np.zeros(len(self.angles))
        quality = []
        for k, (i, j) in enumerate(self.pairs):
            cross = spectrum[:, i] * spectrum[:, j].conj()
            magnitude = np.abs(cross)
            floor = max(float(np.max(magnitude))*1e-6, 1e-12)
            cross = cross / np.maximum(magnitude, floor) * weights
            correlation = np.fft.irfft(cross, n=self.fft_size)
            lag = self.lags[k]
            base = np.floor(lag).astype(int)
            fraction = lag-base
            values = correlation[base % self.fft_size]*(1-fraction)
            values += correlation[(base+1) % self.fft_size]*fraction
            scale = max(float(np.max(np.abs(values))), 1e-9)
            scores += values/scale
            quality.append(float(np.max(values))/max(float(np.sqrt(np.mean(correlation**2))), 1e-9))
        peak = int(np.argmax(scores))
        # Coherence of all pairs at the selected direction; heuristic, not a probability.
        coherence = float(scores[peak]/len(self.pairs))
        sharpness = float(np.clip((np.median(quality)-3.0)/5.0, 0, 1))
        confidence = float(np.clip((coherence-0.2)/0.8, 0, 1))*sharpness
        angle = float(self.angles[peak])
        if self.cfg['mirror']:
            angle = -angle
        angle = (angle+self.cfg['angle_offset_deg']) % 360
        result.update(angle=angle, confidence=confidence,
                      direction_valid=confidence >= self.cfg['min_confidence'],
                      active=confidence >= self.cfg['min_confidence'] and db >= self.cfg['gate_dbfs'],
                      scores=scores.tolist())
        return result


class Tracker:
    def __init__(self, hold):
        self.hold = hold
        self.angle = 0.0
        self.last_active = -1e9
        self.initialized = False
        self.pending_angle = None
        self.pending_count = 0

    def update(self, result, now):
        if result['active']:
            target = result['angle']
            delta = (target-self.angle+180) % 360-180
            expired = now-self.last_active >= self.hold
            if self.initialized and not expired and abs(delta) > 70:
                if self.pending_angle is None or abs((target-self.pending_angle+180) % 360-180) > 25:
                    self.pending_angle, self.pending_count = target, 1
                else:
                    self.pending_count += 1
                if self.pending_count < 3:
                    return self.angle, now-self.last_active < self.hold
                self.angle = target
            else:
                self.angle = target if not self.initialized or expired else (self.angle+0.25*delta) % 360
            self.pending_angle, self.pending_count = None, 0
            self.initialized = True
            self.last_active = now
        else:
            self.pending_angle, self.pending_count = None, 0
        return self.angle, now-self.last_active < self.hold
