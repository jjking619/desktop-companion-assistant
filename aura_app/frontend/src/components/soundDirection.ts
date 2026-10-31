export interface SoundDirection {
    enabled: boolean
    ready: boolean
    tracking: boolean
    yaw_deg: number | null
    confidence: number
    suppressed: boolean
    error: string | null
}

export function parseSoundDirection(value: unknown): SoundDirection {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid sound direction telemetry')
    const data = value as Record<string, unknown>
    if (typeof data.enabled !== 'boolean' || typeof data.ready !== 'boolean' ||
        typeof data.tracking !== 'boolean' || typeof data.suppressed !== 'boolean' ||
        typeof data.confidence !== 'number' || !Number.isFinite(data.confidence) ||
        data.confidence < 0 || data.confidence > 1 ||
        !(data.error === null || typeof data.error === 'string') ||
        !(data.yaw_deg === null || (typeof data.yaw_deg === 'number' &&
            Number.isFinite(data.yaw_deg) && data.yaw_deg >= -180 && data.yaw_deg <= 180)) ||
        (data.tracking && (!data.enabled || !data.ready || data.error !== null || data.yaw_deg === null))) {
        throw new Error('Invalid sound direction telemetry')
    }
    return {
        enabled: data.enabled, ready: data.ready, tracking: data.tracking,
        yaw_deg: data.yaw_deg, confidence: data.confidence,
        suppressed: data.suppressed, error: data.error,
    }
}

export function soundYawRadians(direction: SoundDirection | null): number {
    if (!direction?.tracking || direction.yaw_deg === null) return 0
    return -Math.max(-55, Math.min(55, direction.yaw_deg)) * Math.PI / 180
}

export function advanceSoundYaw(current: number, target: number, delta: number): number {
    const seconds = Math.max(0, Math.min(0.1, delta))
    const change = (target - current) * (1 - Math.exp(-seconds * 7))
    const limit = Math.PI / 2 * seconds
    return current + Math.max(-limit, Math.min(limit, change))
}
