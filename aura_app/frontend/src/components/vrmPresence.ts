import type { VRM } from '@pixiv/three-vrm'
import type { DialogueState } from './speechPresentation'

export interface PresenceFrame {
    time: number
    delta: number
    state: DialogueState
    mouth: number
    blocked: boolean
    reducedMotion: boolean
    soundYaw: number
    pointer: { x: number; y: number } | null
}

export function createVrmPresence(vrm: VRM, random: () => number = Math.random) {
    const chest = vrm.humanoid.getNormalizedBoneNode('upperChest') ??
        vrm.humanoid.getNormalizedBoneNode('chest')
    const spine = vrm.humanoid.getNormalizedBoneNode('spine')
    const head = vrm.humanoid.getNormalizedBoneNode('head')
    const manager = vrm.expressionManager
    const expression = ['relaxed', 'happy'].find(name => {
        const candidate = manager?.getExpression(name)
        return candidate && !candidate.isBinary && candidate.overrideMouth === 'none' &&
            candidate.overrideBlink === 'none' && candidate.overrideLookAt === 'none'
    })
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false
    let nextBlink = 0
    let blinkStarted = -Infinity
    let doubleBlink = false
    let gazeYaw = 0
    let gazePitch = 0
    let headYaw = 0
    let headPitch = 0
    let expressionWeight = 0
    return {
        expression: expression ?? 'none',
        update(frame: PresenceFrame) {
            const { time, reducedMotion, blocked, state } = frame
            const enabled = !reducedMotion && !blocked
            const delta = Math.min(0.1, Math.max(0, frame.delta))
            if (!nextBlink || !enabled) {
                nextBlink = time + 2.8 + random() * 3.2
                blinkStarted = -Infinity
            }
            if (enabled && time >= nextBlink) {
                blinkStarted = time
                doubleBlink = random() < 0.15
                nextBlink = time + 2.8 + random() * 3.2
            }
            const elapsed = time - blinkStarted
            const blinkPhase = doubleBlink && elapsed > 0.28 ? elapsed - 0.28 : elapsed
            const blink = enabled && blinkPhase >= 0 && blinkPhase < 0.24 ?
                Math.sin(Math.PI * blinkPhase / 0.24) ** 2 : 0
            manager?.setValue('blink', blink)
            const breathing = enabled ? Math.sin(time * Math.PI * 2 / 4.6) : 0
            if (chest) chest.rotation.x += breathing * 0.009
            if (spine && enabled) spine.rotation.z += Math.sin(time * Math.PI * 2 / 7.3) * 0.003
            // Sound localization and deliberate thinking poses take priority over pointer attention.
            const attention = enabled && Math.abs(frame.soundYaw) < 0.02 && state !== 'thinking'
            const pointer = attention ? frame.pointer : null
            const yaw = pointer ? Math.max(-1, Math.min(1, pointer.x)) * 0.28 :
                attention ? Math.sin(time * 0.6) * 0.025 : 0
            const pitch = pointer ? -Math.max(-1, Math.min(1, pointer.y)) * 0.16 : 0
            const advance = (current: number, target: number, speed: number) =>
                !enabled ? 0 : current + (target - current) * (1 - Math.exp(-delta * speed))
            gazeYaw = advance(gazeYaw, yaw, 18)
            gazePitch = advance(gazePitch, pitch, 18)
            const headSpeed = attention ? 3.5 : 12
            headYaw = advance(headYaw, pointer ? yaw * 0.32 : 0, headSpeed)
            headPitch = advance(headPitch, pitch * 0.32, headSpeed)
            if (head) {
                head.rotation.y += headYaw
                head.rotation.x += headPitch
            }
            if (vrm.lookAt) {
                vrm.lookAt.yaw = (gazeYaw - headYaw) * 180 / Math.PI
                vrm.lookAt.pitch = (gazePitch - headPitch) * 180 / Math.PI
            }
            const targetExpression = enabled && state === 'speaking' ?
                Math.max(0, Math.min(1, frame.mouth)) * 0.08 : 0
            expressionWeight = advance(expressionWeight, targetExpression, 8)
            if (expression) manager?.setValue(expression, expressionWeight)
            return { breathing, blink, headYaw, headPitch, gazeYaw, gazePitch, expressionWeight }
        },
    }
}
