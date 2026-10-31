"""Unmixed ALSA capture with arecord; no Python audio binding required."""
import os
import logging
import queue
import select
import subprocess
import tempfile
import threading
import time
import wave
import numpy as np


LOGGER = logging.getLogger(__name__)


class Capture:
    def __init__(self, cfg, wav_path=None):
        self.cfg = cfg
        self.process = None
        self.wav = None
        self.stopped = threading.Event()
        self.reader = None
        self.reader_done = threading.Event()
        self.reader_error = None
        self.pending = queue.Queue(maxsize=8)
        self.resyncs = 0
        self.dropped_blocks = 0
        self.error_log = tempfile.TemporaryFile()
        if wav_path:
            self.wav = wave.open(wav_path, 'rb')
            if (self.wav.getnchannels(), self.wav.getframerate(), self.wav.getsampwidth()) != (8, 48000, 2):
                self.close()
                raise ValueError('WAV must be 8-channel, 48000 Hz, 16-bit PCM')
        else:
            try:
                self.process = subprocess.Popen(['arecord', '-q', '-D', cfg['device'], '-f',
                    'S16_LE', '-r', str(cfg['rate']), '-c', str(cfg['channels']), '-t', 'raw',
                    '--buffer-time=500000', '--period-time=20000'],
                    stdout=subprocess.PIPE, stderr=self.error_log,
                    env=dict(os.environ, LC_ALL='C'))
            except Exception:
                self.close()
                raise

    def frames(self):
        n = self.cfg['frame_size']
        size = n*self.cfg['channels']*2
        if self.wav:
            while not self.stopped.is_set():
                chunk = self.wav.readframes(n)
                if len(chunk) < size:
                    return
                yield np.frombuffer(chunk, dtype='<i2').reshape(n, 8)
            return
        if self.reader is None:
            self.reader = threading.Thread(target=self._read, daemon=True, name='sound-capture')
            self.reader.start()
        while not self.stopped.is_set():
            if self.reader_error is not None:
                raise self.reader_error
            try:
                chunk = self.pending.get(timeout=0.2)
            except queue.Empty:
                if self.reader_done.is_set():
                    if self.reader_error is not None:
                        raise self.reader_error
                    return
                continue
            data, self.resyncs, self.dropped_blocks = chunk
            yield np.frombuffer(data, dtype='<i2').reshape(n, self.cfg['channels'])

    def _read(self):
        resyncs = dropped_blocks = 0
        try:
            for chunk in self._chunks():
                try:
                    self.pending.put_nowait((chunk, resyncs, dropped_blocks))
                except queue.Full:
                    discarded = 0
                    while True:
                        try:
                            self.pending.get_nowait()
                            discarded += 1
                        except queue.Empty:
                            break
                    resyncs += 1
                    dropped_blocks += discarded
                    LOGGER.warning(
                        "Microphone processing backlog: discarded %s stale blocks; "
                        "resynchronizing live capture (resync %s)", discarded, resyncs,
                    )
                    self.pending.put_nowait((chunk, resyncs, dropped_blocks))
        except (OSError, RuntimeError, ValueError) as error:
            self.reader_error = error
        finally:
            self.reader_done.set()

    def _chunks(self):
        size = self.cfg['frame_size'] * self.cfg['channels'] * 2
        buffer = bytearray()
        deadline = time.monotonic()+4
        while not self.stopped.is_set():
            readable, _, _ = select.select([self.process.stdout], [], [], 0.2)
            if not readable:
                if time.monotonic() > deadline:
                    raise RuntimeError('Audio capture timed out. Check USB connection and device availability')
                continue
            data = os.read(self.process.stdout.fileno(), max(4096, size-len(buffer)))
            if not data:
                code = self.process.wait()
                length = self.error_log.seek(0, os.SEEK_END)
                self.error_log.seek(max(0, length - 2048))
                error = self.error_log.read(2048).decode(errors='replace').strip()
                if not self.stopped.is_set():
                    reason = f'signal {-code}' if code < 0 else f'exit code {code}'
                    summary = ' '.join(error.splitlines()[-3:])[-512:]
                    raise RuntimeError(f'Audio capture stopped ({reason}): {summary or "Audio device disconnected"}')
                return
            deadline = time.monotonic()+4
            buffer.extend(data)
            while len(buffer) >= size:
                chunk = bytes(buffer[:size])
                del buffer[:size]
                yield chunk

    def close(self):
        self.stopped.set()
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        if self.reader is not None:
            self.reader.join(timeout=2)
            if self.reader.is_alive():
                raise RuntimeError('Audio capture reader did not stop')
        if self.process:
            self.process.stdout.close()
        if self.wav:
            self.wav.close()
        self.error_log.close()
