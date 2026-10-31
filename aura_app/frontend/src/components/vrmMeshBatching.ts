import { BufferAttribute, Mesh, SkinnedMesh } from 'three'
import type { Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Keep facial morphs and transparent sorting intact; batch only identical static skin primitives.
export function combineStaticSkinnedPrimitives(root: Object3D) {
    root.updateMatrixWorld(true)
    const groups = new Map<string, SkinnedMesh[]>()
    root.traverse(object => {
        if (!(object instanceof SkinnedMesh) || Array.isArray(object.material) ||
            object.material.transparent || object.children.length ||
            Object.keys(object.geometry.morphAttributes).length ||
            object.geometry.groups.length || object.geometry.drawRange.start !== 0 ||
            object.geometry.drawRange.count !== Infinity) return
        const attributes = Object.entries(object.geometry.attributes).sort(([a], [b]) => a.localeCompare(b))
        const layout = attributes.map(([name, attribute]) => attribute instanceof BufferAttribute ?
            [name, attribute.itemSize, attribute.normalized, attribute.array.constructor.name, attribute.gpuType] : null)
        if (layout.includes(null)) return
        const key = JSON.stringify([
            object.parent?.uuid, object.material.uuid, object.skeleton.uuid, object.bindMode,
            object.matrix.elements, object.bindMatrix.elements, object.bindMatrixInverse.elements,
            object.visible, object.layers.mask, object.renderOrder, object.frustumCulled,
            object.castShadow, object.receiveShadow, object.geometry.index !== null,
            object.geometry.morphTargetsRelative,
            layout,
        ])
        const meshes = groups.get(key) ?? []
        meshes.push(object)
        groups.set(key, meshes)
    })
    const replaced = new Set<SkinnedMesh['geometry']>()
    for (const meshes of groups.values()) {
        const first = meshes[0]
        if (meshes.length < 2 || meshes.some(mesh =>
            mesh.onBeforeRender !== first.onBeforeRender || mesh.onAfterRender !== first.onAfterRender)) continue
        const geometry = mergeGeometries(meshes.map(mesh => mesh.geometry))
        if (!geometry) throw new Error(`Cannot batch VRM primitives for ${first.name}`)
        for (const mesh of meshes) replaced.add(mesh.geometry)
        first.geometry = geometry
        first.computeBoundingBox()
        first.computeBoundingSphere()
        for (const mesh of meshes.slice(1)) mesh.removeFromParent()
    }
    root.traverse(object => {
        if (object instanceof Mesh) replaced.delete(object.geometry)
    })
    for (const geometry of replaced) geometry.dispose()
}
