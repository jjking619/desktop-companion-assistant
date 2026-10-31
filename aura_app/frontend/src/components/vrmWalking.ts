import { AnimationMixer, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { createGentleGestures, gestureDurations } from './vrmGestures.ts'
import type { IdleAction } from './vrmCharacter'

const mapping = {
    Hips: 'hips', Abdomen: 'spine', Torso: 'chest', Neck: 'neck', Head: 'head',
    'Shoulder.L': 'leftShoulder', 'UpperArm.L': 'leftUpperArm',
    'LowerArm.L': 'leftLowerArm', 'Palm2.L': 'leftHand',
    'Shoulder.R': 'rightShoulder', 'UpperArm.R': 'rightUpperArm',
    'LowerArm.R': 'rightLowerArm', 'Palm2.R': 'rightHand',
    'UpperLeg.L': 'leftUpperLeg', 'LowerLeg.L': 'leftLowerLeg', 'Foot.L': 'leftFoot',
    'UpperLeg.R': 'rightUpperLeg', 'LowerLeg.R': 'rightLowerLeg', 'Foot.R': 'rightFoot',
} as const

export function createVrmWalk(vrm: VRM, source: GLTF) {
    const clip = source.animations.find(animation => animation.name === 'Walking')
    if (!clip) throw new Error('Motion asset has no Walking animation')
    const gestures = createGentleGestures(vrm)
    const nodes = new Map<string, Object3D>()
    source.scene.updateMatrixWorld(true)
    source.scene.traverse(object => {
        const index = source.parser.associations.get(object)?.nodes
        if (index !== undefined) nodes.set(source.parser.json.nodes[index].name, object)
    })
    const leftArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm')
    const rightArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm')
    if (!leftArm || !rightArm) throw new Error('Model is missing arm bones')
    const leftElbow = vrm.humanoid.getNormalizedBoneNode('leftLowerArm')
    const rightElbow = vrm.humanoid.getNormalizedBoneNode('rightLowerArm')
    if (!leftElbow || !rightElbow) throw new Error('Model is missing elbow bones')
    const leftArmSign = leftElbow.position.x > 0 ? -1 : 1
    const rightArmSign = rightElbow.position.x > 0 ? -1 : 1
    const relaxedFingers = (['left', 'right'] as const).flatMap(side =>
        (['Index', 'Middle', 'Ring', 'Little'] as const).flatMap(finger =>
            (['Proximal', 'Intermediate', 'Distal'] as const).map((segment, index) => {
                const node = vrm.humanoid.getNormalizedBoneNode(`${side}${finger}${segment}`)
                const next = vrm.humanoid.getNormalizedBoneNode(`${side}${finger}Intermediate`)
                return { node, angle: (next && next.position.x > 0 ? -1 : 1) * [0.12, 0.16, 0.1][index] }
            })))
    const standing = () => {
        vrm.humanoid.resetNormalizedPose()
        leftArm.rotation.set(-0.04, 0, leftArmSign * 1.32)
        rightArm.rotation.set(-0.04, 0, rightArmSign * 1.32)
        leftElbow.rotation.y = -0.18
        rightElbow.rotation.y = 0.18
        for (const { node, angle } of relaxedFingers) {
            if (node) node.rotation.z = angle
        }
    }
    // Match the source's arms-down rest pose to VRM's normalized T-pose.
    vrm.humanoid.resetNormalizedPose()
    leftArm.rotation.z = leftArmSign * 1.15
    rightArm.rotation.z = rightArmSign * 1.15
    vrm.update(0)
    const joints = Object.entries(mapping).map(([name, target]) => {
        const bone = nodes.get(name)
        const destination = vrm.humanoid.getNormalizedBoneNode(target)
        if (!bone || !destination) throw new Error(`Missing walk bone: ${name} -> ${target}`)
        return { bone, destination,
            inverseRest: bone.getWorldQuaternion(new Quaternion()).invert(),
            targetRest: destination.getWorldQuaternion(new Quaternion()) }
    })
    const sourceHips = nodes.get('Hips')!
    const targetHips = vrm.humanoid.getNormalizedBoneNode('hips')!
    const originalHips = sourceHips.getWorldPosition(new Vector3())
    const hipsBase = targetHips.position.clone()
    const hipHeight = targetHips.getWorldPosition(new Vector3()).y
    if (originalHips.y <= 0 || hipHeight <= 0) throw new Error('Invalid walk hip heights')
    const mixer = new AnimationMixer(source.scene)
    mixer.clipAction(clip).play()
    const rotation = new Quaternion()
    const parentRotation = new Quaternion()
    const identity = new Quaternion()
    const hips = new Vector3()
    standing()
    const idleRotations = joints.map(joint => joint.destination.quaternion.clone())
    const applyPose = (time: number, weight: number) => {
        standing()
        if (weight === 0) return
        mixer.setTime(time)
        for (const joint of joints) {
            joint.bone.getWorldQuaternion(rotation)
            rotation.multiply(joint.inverseRest).slerp(identity, 1 - 0.45)
                .multiply(joint.targetRest)
            joint.destination.parent!.getWorldQuaternion(parentRotation).invert()
            joint.destination.quaternion.copy(parentRotation.multiply(rotation))
            joint.destination.updateMatrixWorld(true)
        }
        for (const [index, joint] of joints.entries()) {
            joint.destination.quaternion.slerp(idleRotations[index], 1 - weight)
        }
        sourceHips.getWorldPosition(hips)
        targetHips.position.copy(hipsBase)
        targetHips.position.y += (hips.y - originalHips.y) * hipHeight / originalHips.y * 0.45 * weight
    }
    return {
        apply(cycle: number, weight: number) {
            applyPose(clip.duration * ((cycle % 1 + 1) % 1), weight)
        },
        getIdleDuration(name: IdleAction) {
            return gestureDurations[name]
        },
        applyIdle(name: IdleAction, elapsed: number, weight: number) {
            standing()
            gestures.apply(name, elapsed, weight)
        },
        dispose() {
            mixer.stopAllAction()
            mixer.uncacheRoot(source.scene)
        },
    }
}
