import { VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm'
import type { BufferAttribute, InterleavedBufferAttribute } from 'three'

export function scaleMouthOpening(expression: VRMExpression | null | undefined, scale: number) {
    if (!expression) throw new Error('VRM is missing the aa mouth expression')
    const targets = new Set<BufferAttribute | InterleavedBufferAttribute>()
    for (const bind of expression.binds) {
        if (!(bind instanceof VRMExpressionMorphTargetBind)) continue
        for (const mesh of bind.primitives) {
            if (!mesh.geometry.morphTargetsRelative) {
                throw new Error('Mouth opening requires relative morph targets')
            }
            const target = mesh.geometry.morphAttributes.position?.[bind.index]
            if (!target) throw new Error('VRM mouth expression is missing its position target')
            targets.add(target)
        }
    }
    if (targets.size === 0) throw new Error('VRM mouth expression has no morph targets')
    // GLTF primitives can share one target buffer; scale it only once.
    for (const target of targets) {
        for (let index = 0; index < target.count; index++) {
            target.setY(index, target.getY(index) * scale)
        }
        target.needsUpdate = true
    }
}
