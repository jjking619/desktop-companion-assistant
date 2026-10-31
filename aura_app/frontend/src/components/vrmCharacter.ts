export const vrmCharacter = {
    autoRoaming: false,
    width: 246,
    height: 456,
    stride: 92,
    duration: 0.9583333134651184,
    mouthOpeningScale: 1,
    model: './characters/AvatarSample_A.vrm',
    motion: './characters/maid-original/RobotExpressive.glb',
}

export const idleActions = ['ThumbsUp', 'Dance'] as const
export type IdleAction = typeof idleActions[number]
export const actionLabels: Record<IdleAction, string> = { ThumbsUp: '点赞', Dance: '轻柔律动' }
export const actionPreferenceKey = 'aura-preferred-action'

export function isIdleAction(value: string): value is IdleAction {
    return value === 'ThumbsUp' || value === 'Dance'
}

export function getIdleActionWeight(elapsed: number, duration: number) {
    const t = Math.max(0, Math.min(1, elapsed / 0.65, (duration - elapsed) / 0.75))
    return t * t * t * (t * (t * 6 - 15) + 10)
}
