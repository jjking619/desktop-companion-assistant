import { Euler, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import type { IdleAction } from './vrmCharacter'

export const gestureDurations: Record<IdleAction, number> = { ThumbsUp: 3.6, Dance: 5.6 }

export function createGentleGestures(vrm: VRM) {
    const bone = (name: VRMHumanBoneName) => {
        const node = vrm.humanoid.getNormalizedBoneNode(name)
        if (!node) throw new Error(`Gentle gesture requires humanoid bone: ${name}`)
        return node
    }
    const upper = bone('rightUpperArm')
    const lower = bone('rightLowerArm')
    const hand = bone('rightHand')
    const thumb = bone('rightThumbMetacarpal')
    const thumbAxis = bone('rightThumbProximal').position.clone().normalize()
    const leftUpper = bone('leftUpperArm')
    const leftLower = bone('leftLowerArm')
    const leftHand = bone('leftHand')
    const leftArmSign = leftLower.position.x > 0 ? -1 : 1
    const rightArmSign = lower.position.x > 0 ? -1 : 1
    const chest = bone('chest')
    const neck = bone('neck')
    const head = bone('head')
    const fingers = (['Index', 'Middle', 'Ring', 'Little'] as const).map(name =>
        (['Proximal', 'Intermediate', 'Distal'] as const).map(segment =>
            bone(`right${name}${segment}`)))
    const curlSign = fingers[0][1].position.x > 0 ? -1 : 1
    const upperAxis = lower.position.clone().normalize()
    const lowerAxis = hand.position.clone().normalize()
    const parentRotation = new Quaternion()
    const target = new Quaternion()
    const direction = new Vector3()
    const euler = new Euler()
    const handRotation = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0))
    const blendRotation = (node: Object3D, x: number, y: number, z: number, weight: number) => {
        target.setFromEuler(euler.set(x, y, z))
        node.quaternion.slerp(target, weight)
        node.updateWorldMatrix(false, true)
    }
    const aim = (node: Object3D, axis: Vector3, x: number, y: number, z: number, weight: number) => {
        node.parent!.getWorldQuaternion(parentRotation).invert()
        direction.set(x, y, z).normalize().applyQuaternion(parentRotation)
        target.setFromUnitVectors(axis, direction)
        node.quaternion.slerp(target, weight)
        node.updateWorldMatrix(false, true)
    }
    return {
        apply(name: IdleAction, elapsed: number, weight: number) {
            if (weight === 0) return
            if (name === 'ThumbsUp') {
                // Keep the elbow beside the waist and lift the forearm in front of the chest.
                aim(upper, upperAxis, -0.35, -0.9, 0.25, weight)
                aim(lower, lowerAxis, 0.05, 0.82, 0.57, weight)
                hand.parent!.getWorldQuaternion(parentRotation).invert()
                target.copy(parentRotation).multiply(handRotation)
                hand.quaternion.slerp(target, weight)
                hand.updateWorldMatrix(false, true)
                for (const segments of fingers) {
                    for (const [index, segment] of segments.entries()) {
                        blendRotation(segment, 0, 0, curlSign * [1.25, 1.35, 0.8][index], weight)
                    }
                }
                aim(thumb, thumbAxis, 0, 1, 0, weight)
                blendRotation(head, 0.045, 0, -0.025, weight)
            } else {
                // The pelvis and legs stay in their standing pose to keep both feet planted.
                const phase = elapsed * Math.PI * 2 / 2.8
                const sway = Math.sin(phase)
                const follow = Math.sin(phase - 0.45)
                blendRotation(chest, 0, 0.025 * follow, 0.025 * sway, weight)
                blendRotation(neck, 0, -0.012 * follow, -0.012 * sway, weight)
                blendRotation(head, 0.012 * Math.sin(phase * 2), 0, -0.012 * sway, weight)
                blendRotation(leftUpper, -0.04, 0.04 * follow, leftArmSign * (1.34 + 0.045 * sway), weight)
                blendRotation(upper, -0.04, -0.04 * follow, rightArmSign * (1.34 - 0.045 * sway), weight)
                blendRotation(leftLower, 0, -0.22 - 0.035 * follow, 0, weight)
                blendRotation(lower, 0, 0.22 - 0.035 * follow, 0, weight)
                blendRotation(leftHand, 0.025 * follow, 0, 0, weight)
                blendRotation(hand, -0.025 * follow, 0, 0, weight)
            }
        },
    }
}
