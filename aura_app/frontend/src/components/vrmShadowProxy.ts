import { Group, Mesh, MeshBasicMaterial, SkinnedMesh } from 'three'
import type { Object3D, Vector3 } from 'three'
import { clone } from 'three/addons/utils/SkeletonUtils.js'

// Never upload the avatar's mutable skin/morph resources into a second WebGL context.
export function createShadowProxy(root: Object3D) {
    const group = new Group()
    const material = new MeshBasicMaterial()
    material.colorWrite = false
    material.depthWrite = false
    const copy = clone(root)
    group.add(copy)
    const sources: Object3D[] = []
    const targets: Object3D[] = []
    const meshes: Mesh[] = []
    const skeletons = new Set<SkinnedMesh['skeleton']>()
    const skeletonCopies = new Map<SkinnedMesh['skeleton'], SkinnedMesh['skeleton']>()
    root.traverse(source => sources.push(source))
    copy.traverse(target => {
        targets.push(target)
        if (!(target instanceof Mesh)) return
        target.geometry = target.geometry.clone()
        target.material = material
        target.castShadow = true
        target.frustumCulled = false
        meshes.push(target)
        const source = sources[targets.length - 1]
        if (source instanceof SkinnedMesh && target instanceof SkinnedMesh) {
            const existing = skeletonCopies.get(source.skeleton)
            if (existing) target.skeleton = existing
            else skeletonCopies.set(source.skeleton, target.skeleton)
            skeletons.add(target.skeleton)
        }
    })
    return {
        group,
        update(offset: Vector3) {
            group.position.copy(offset)
            for (let index = 0; index < sources.length; index++) {
                const source = sources[index], target = targets[index]
                target.position.copy(source.position)
                target.quaternion.copy(source.quaternion)
                target.scale.copy(source.scale)
                target.matrix.copy(source.matrix)
                target.visible = source.visible
                if (source instanceof Mesh && target instanceof Mesh && source.morphTargetInfluences &&
                    target.morphTargetInfluences) {
                    for (let morph = 0; morph < source.morphTargetInfluences.length; morph++) {
                        target.morphTargetInfluences[morph] = source.morphTargetInfluences[morph]
                    }
                }
            }
        },
        dispose() {
            for (const mesh of meshes) mesh.geometry.dispose()
            for (const skeleton of skeletons) skeleton.dispose()
            material.dispose()
        },
    }
}
