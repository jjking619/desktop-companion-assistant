def classify_landmarks(landmarks):
    try:
        index_open = landmarks[8].y < landmarks[6].y
        middle_open = landmarks[12].y < landmarks[10].y
        ring_open = landmarks[16].y < landmarks[14].y
        pinky_open = landmarks[20].y < landmarks[18].y
        thumb_open = landmarks[4].x < landmarks[3].x or landmarks[4].y < landmarks[3].y

        if index_open and not middle_open and not ring_open and not pinky_open:
            return "pointing"
        if index_open and middle_open and not ring_open and not pinky_open:
            return "peace"
        if all([index_open, middle_open, ring_open, pinky_open]):
            return "open_palm"
        if not any([index_open, middle_open, ring_open, pinky_open]):
            return "thumbs_up" if thumb_open else "closed_fist"
        return "none"
    except (IndexError, AttributeError, TypeError) as error:
        print(f"[Gesture] Invalid landmarks: {error}")
        return "none"


def most_frequent(deque_buf, fallback="neutral"):
    if not deque_buf:
        return fallback
    values = list(deque_buf)
    return max(set(values), key=values.count)
