from dataclasses import dataclass
from functools import lru_cache
import math
import re
import unicodedata


class SpeechTimingError(ValueError):
    pass


@dataclass(frozen=True)
class MouthCue:
    start_ms: float
    end_ms: float
    viseme: str | None
    trajectory: tuple[str | None, ...] = ()
    closed_onset: bool = False


_ENGLISH_VISEMES = {
    "AA": ("aa",), "AE": ("aa",), "AH": ("aa",), "AO": ("oh",),
    "AW": ("aa", "ou"), "AY": ("aa", "ih"),
    "EH": ("ee",), "ER": ("ee",), "EY": ("ee", "ih"),
    "IH": ("ih",), "IY": ("ih",), "OW": ("oh", "ou"),
    "OY": ("oh", "ih"), "UH": ("ou",), "UW": ("ou",),
    "W": ("ou",), "Y": ("ih",),
    "B": (None,), "P": (None,), "M": (None,),
}


@lru_cache(maxsize=1)
def _english_pronunciations():
    try:
        import cmudict
    except ImportError as error:
        raise SpeechTimingError("缺少英文口型词典 cmudict，请更新 Linux 后端依赖。") from error
    return cmudict.dict()


def _english_trajectory(token):
    lexicon = _english_pronunciations()
    phones = []
    for part in token.split():
        pronunciations = lexicon.get(part.lower())
        if pronunciations:
            phones.extend(pronunciations[0])
        elif "-" in part and all(piece.lower() in lexicon for piece in part.split("-")):
            for piece in part.split("-"):
                phones.extend(lexicon[piece.lower()][0])
        elif part.isascii() and part.isalpha() and part.isupper() and 1 < len(part) <= 8:
            for letter in part.lower():
                phones.extend(lexicon[letter][0])
        else:
            return None
    trajectory = []
    for phone in phones:
        shapes = _ENGLISH_VISEMES.get(phone.rstrip("012"), ())
        stress = phone[-1] if phone[-1:] in ("0", "1", "2") else "0"
        duration = 3 if stress == "1" else 2 if stress == "2" else 1
        for shape in shapes:
            trajectory.extend([shape] * duration)
    return tuple(trajectory)


def vowel_trajectory(final):
    final = final.replace("ü", "v")
    sequences = {
        "ai": ("aa", "ih"), "ei": ("ee", "ih"),
        "ao": ("aa", "ou"), "ou": ("oh", "ou"),
        "ia": ("ih", "aa"), "iao": ("ih", "aa", "ou"),
        "ie": ("ih", "ee"), "iu": ("ih", "ou"),
        "ua": ("ou", "aa"), "uai": ("ou", "aa", "ih"),
        "uo": ("ou", "oh"), "ui": ("ou", "ee", "ih"),
        "ue": ("ou", "ee"), "ve": ("ou", "ee"),
        "ian": ("ih", "ee"), "iang": ("ih", "aa"),
        "uan": ("ou", "aa"), "uang": ("ou", "aa"),
        "ong": ("ou",), "iong": ("ih", "ou"),
    }
    return sequences.get(final, ())


def build_mouth_cues(sentences: list[dict], duration_ms: float) -> list[MouthCue]:
    from pypinyin import Style, pinyin

    cues = []
    unsupported = 0
    english_fallbacks = 0
    for sentence in sentences:
        words = sentence.get("words")
        if not isinstance(words, list):
            raise SpeechTimingError("语音服务没有返回字级时间戳。")
        for word in words:
            if not isinstance(word, dict):
                raise SpeechTimingError("语音服务返回了无效的字级时间戳。")
            token = word.get("text")
            start, end = word.get("begin_time"), word.get("end_time")
            if (not isinstance(token, str) or
                    not isinstance(start, (int, float)) or isinstance(start, bool) or
                    not isinstance(end, (int, float)) or isinstance(end, bool) or
                    not math.isfinite(start) or not math.isfinite(end) or
                    start < 0 or end <= start or end > duration_ms + 1):
                raise SpeechTimingError("语音服务返回了无效的字级时间戳。")
        text = "".join(word["text"] for word in words)
        finals = pinyin(text, style=Style.FINALS, strict=False, errors=lambda value: list(value))
        initials = pinyin(text, style=Style.INITIALS, strict=False, errors=lambda value: list(value))
        cursor = 0
        for word in words:
            token = word["text"]
            start, end = word["begin_time"], word["end_time"]
            final = finals[cursor][0] if len(token) == 1 else ""
            initial = initials[cursor][0] if len(token) == 1 else ""
            cursor += len(token)
            shape = None
            trajectory = ()
            closed_onset = initial in ("b", "p", "m")
            english_mapped = False
            english = token.replace("\u2019", "'").replace("\u2018", "'")
            english = re.sub(r'[.,!?;:()\[\]{}"\u201c\u201d\u2013\u2014]', " ", english).strip(" \t\r\n'")
            english = " ".join(english.split())
            if len(token) == 1 and "\u3400" <= token <= "\u9fff":
                if "a" in final:
                    shape = "aa"
                elif "o" in final:
                    shape = "oh"
                elif "e" in final:
                    shape = "ee"
                elif "u" in final or "v" in final or "ü" in final:
                    shape = "ou"
                elif "i" in final:
                    shape = "ih"
                trajectory = vowel_trajectory(final) if shape else ()
            elif (re.fullmatch(r"[A-Za-z0-9]+(?:['\-\s][A-Za-z0-9]+)*", english)
                  and re.search(r"[A-Za-z]", english)):
                english_mapped = True
                articulation = _english_trajectory(english)
                if articulation is None:
                    shape = "aa"
                    english_fallbacks += 1
                else:
                    trajectory = articulation
                    shape = next((value for value in trajectory if value is not None), None)
                    closed_onset = bool(trajectory and trajectory[0] is None)
            if shape is None and not english_mapped and ("\ufffd" in token or
                                  any(unicodedata.category(char)[0] in ("L", "N") for char in token)):
                unsupported += 1
            cues.append(MouthCue(start, min(end, duration_ms), shape,
                                 trajectory, closed_onset))
    if not cues:
        raise SpeechTimingError("当前音色未返回可用的字级口型时间轴，请检查音色是否支持时间戳。")
    if unsupported:
        print(f"[LipSync] {unsupported} timestamp token(s) have no supported Chinese/English articulation "
              "mapping; those intervals use a neutral mouth. This is not an ASR failure.")
    if english_fallbacks:
        print(f"[LipSync] {english_fallbacks} 个英文词未命中发音词典；使用词时间戳和真实音量开合口型，未生成音素时间戳。")
    cues.sort(key=lambda cue: cue.start_ms)
    if any(right.start_ms < left.end_ms for left, right in zip(cues, cues[1:])):
        raise SpeechTimingError("字级时间戳重叠或时间轴重置，无法准确驱动口型。")
    return cues


def mouth_at(cues: list[MouthCue], elapsed_ms: float) -> str | None:
    for cue in cues:
        if cue.start_ms > elapsed_ms:
            break
        if cue.start_ms <= elapsed_ms < cue.end_ms:
            return cue.viseme
    return None


def mouth_weights_at(cues: list[MouthCue], elapsed_ms: float) -> dict[str, float]:
    weights = dict.fromkeys(("aa", "ih", "ou", "ee", "oh"), 0.0)
    for index, cue in enumerate(cues):
        if not cue.start_ms <= elapsed_ms < cue.end_ms:
            continue
        if cue.viseme is None:
            return weights
        duration = cue.end_ms - cue.start_ms
        phase = (elapsed_ms - cue.start_ms) / duration
        shapes = cue.trajectory or (cue.viseme,)
        position = min(1.0, max(0.0, (phase - 0.12) / 0.76)) * (len(shapes) - 1)
        left = int(position)
        blend = position - left
        blend = blend * blend * (3 - 2 * blend)
        if shapes[left] is not None:
            weights[shapes[left]] += 1 - blend
        right = shapes[min(left + 1, len(shapes) - 1)]
        if right is not None:
            weights[right] += blend
        # These are rule-based articulatory envelopes, not measured phoneme timings.
        if cue.closed_onset:
            ramp = min(1.0, (elapsed_ms - cue.start_ms) / min(55, duration * 0.25))
            weights = {key: value * ramp * ramp * (3 - 2 * ramp) for key, value in weights.items()}
        previous = cues[index - 1] if index else None
        if (not cue.closed_onset and previous and previous.viseme is not None
                and abs(previous.end_ms - cue.start_ms) < 1):
            progress = min(1.0, (elapsed_ms - cue.start_ms) / min(65, duration * 0.3))
            progress = progress * progress * (3 - 2 * progress)
            weights = {key: value * progress for key, value in weights.items()}
            previous_shape = (previous.trajectory or (previous.viseme,))[-1]
            if previous_shape is not None:
                weights[previous_shape] += 1 - progress
        return weights
    return weights
