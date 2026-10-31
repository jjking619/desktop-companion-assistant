export const speechVisemes = ['aa', 'ih', 'ou', 'ee', 'oh'] as const
export type SpeechViseme = typeof speechVisemes[number]
export type MouthWeights = Record<SpeechViseme, number>
export type DialogueState = 'idle' | 'listening' | 'thinking' | 'speaking'

export function getDialogueState(audio: SpeechAudioState, pending = false): DialogueState {
    if (audio.is_listening) return 'listening'
    if (audio.is_speaking) return 'speaking'
    if (audio.dialogue_state === 'listening' || audio.dialogue_state === 'speaking' ||
        audio.dialogue_state === 'thinking') return audio.dialogue_state
    return audio.is_preparing || pending ? 'thinking' : 'idle'
}

export function getDialoguePose(state: DialogueState, elapsed: number, level: number, reducedMotion = false) {
    if (reducedMotion || state === 'idle') return { pitch: 0, yaw: 0, roll: 0, blink: 0 }
    const time = Math.max(0, elapsed)
    const nodPhase = time % 5.3
    const nod = nodPhase > 1.4 && nodPhase < 2.1 ? Math.sin((nodPhase - 1.4) / 0.7 * Math.PI) : 0
    const blinkPhase = time % 4.7
    const blink = blinkPhase > 3.8 && blinkPhase < 4 ?
        Math.sin((blinkPhase - 3.8) / 0.2 * Math.PI) : 0
    return {
        pitch: state === 'listening' ? -0.025 + nod * 0.055 :
            state === 'thinking' ? -0.025 : Math.max(0, Math.min(1, level)) * 0.035,
        yaw: state === 'thinking' ? -0.065 + Math.sin(time * 0.65) * 0.015 : 0,
        roll: state === 'listening' ? -0.025 : state === 'thinking' ? 0.018 : 0,
        blink,
    }
}

export function advanceMouthWeight(current: number, target: number, delta: number): number {
    const next = current + (target - current) *
        (1 - Math.exp(-Math.max(0, delta) * (target > current ? 40 : 55)))
    return target === 0 && next < 0.01 ? 0 : next
}

export interface SpeechAudioState {
    conversation_active?: boolean
    conversation_phase?: 'idle' | 'waiting' | 'listening' | 'recognizing' | 'replying' | 'cooldown'
    is_speaking: boolean
    is_listening: boolean
    is_preparing?: boolean
    first_audio_latency_ms?: number | null
    last_segment_gap_ms?: number | null
    dialogue_state?: DialogueState
    audio_level: number
    viseme?: SpeechViseme | null
    mouth_weights?: MouthWeights | null
    lip_sync_mode?: 'amplitude' | 'word-timestamps'
    speech_text?: string
    error?: string | null
    volume_percent?: number
    gesture_volume_enabled?: boolean
}

export function getSpeechMouthWeights(level: number, viseme: SpeechViseme | null = 'aa',
    articulation?: MouthWeights | null): MouthWeights {
    if (articulation) {
        if (speechVisemes.some(shape => !Number.isFinite(articulation[shape]) ||
            articulation[shape] < 0 || articulation[shape] > 1)) {
            throw new Error('Invalid speech articulation weights')
        }
        const total = speechVisemes.reduce((sum, shape) => sum + articulation[shape], 0)
        const scale = Math.max(1, total)
        const speechActive = level > 0 ? 1 : 0
        return {
            aa: speechActive * articulation.aa / scale, ih: speechActive * articulation.ih / scale,
            ou: speechActive * articulation.ou / scale, ee: speechActive * articulation.ee / scale,
            oh: speechActive * articulation.oh / scale,
        }
    }
    return {
        aa: viseme === 'aa' ? level : 0,
        ih: viseme === 'ih' ? level : 0,
        ou: viseme === 'ou' ? level : 0,
        ee: viseme === 'ee' ? level : 0,
        oh: viseme === 'oh' ? level : 0,
    }
}

export function getSpeechMouthLevel(speaking: boolean, level: number): number {
    if (!speaking || !Number.isFinite(level) || level <= 0.025) return 0
    const opening = Math.sqrt(Math.min(1, (level - 0.025) / 0.975))
    return 1 - (1 - opening) ** 2
}

export function getDialogueCameraFrame(modelHeight: number, fullHalfHeight: number,
    modelTop: number, headY: number) {
    const halfHeight = modelHeight * 0.24
    const headroom = modelTop - headY
    return {
        zoom: fullHalfHeight / halfHeight,
        centerY: headY + headroom * 1.2 - halfHeight,
    }
}
