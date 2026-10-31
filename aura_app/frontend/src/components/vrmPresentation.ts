import {
    Box3, Color, CylinderGeometry, DataTexture, DirectionalLight, GridHelper, Group, HemisphereLight, LinearFilter,
    Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, SRGBColorSpace, Vector3,
} from 'three'
import { MToonMaterial } from '@pixiv/three-vrm'

export const characterFov = 20
export const studioPreferenceKey = 'aura-studio-background'

export function frameGlobalStudio(camera: PerspectiveCamera,
    rect: { x: number; y: number; width: number; height: number },
    width: number, height: number, zoom: number) {
    camera.aspect = width / height
    camera.zoom = zoom * Math.max(1, rect.height) / height
    camera.setViewOffset(width, height,
        width / 2 - rect.x - rect.width / 2, height / 2 - rect.y - rect.height / 2, width, height)
    camera.updateProjectionMatrix()
}

export function createStudioStage(height: number, floorY: number) {
    const group = new Group()
    const pixels = new Uint8Array(64 * 64 * 4)
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const light = Math.exp(-((x / 63 - 0.43) ** 2 + (y / 63 - 0.19) ** 2) * 55)
            const offset = (y * 64 + x) * 4
            pixels[offset] = 45 + Math.round(light * 65)
            pixels[offset + 1] = 65 + Math.round(light * 73)
            pixels[offset + 2] = 82 + Math.round(light * 80)
            pixels[offset + 3] = 255
        }
    }
    const wallTexture = new DataTexture(pixels, 64, 64)
    wallTexture.colorSpace = SRGBColorSpace
    wallTexture.magFilter = wallTexture.minFilter = LinearFilter
    wallTexture.needsUpdate = true
    const floor = new Mesh(new PlaneGeometry(height * 64, height * 64),
        new MeshStandardMaterial({ color: 0x536879, roughness: 0.94 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = floorY - height * 0.035
    floor.receiveShadow = true
    const platform = new Mesh(new CylinderGeometry(height * 0.62, height * 0.65,
        height * 0.035, 64), new MeshStandardMaterial({ color: 0x8798a5, roughness: 0.85 }))
    platform.position.set(0, floorY - height * 0.0175, 0)
    platform.receiveShadow = true
    const wall = new Mesh(new PlaneGeometry(height * 12, height * 8),
        new MeshBasicMaterial({ map: wallTexture }))
    wall.position.set(0, floorY + height * 3, -height * 1.5)
    const grid = new GridHelper(height * 16, 32, 0x8ba7ba, 0x8ba7ba)
    grid.position.y = floor.position.y + height * 0.0005
    grid.material.transparent = true
    grid.material.opacity = 0.16
    grid.material.depthWrite = false
    group.add(floor, platform, wall, grid)
    for (const x of [-0.95, 0.95]) {
        const panel = new Mesh(new PlaneGeometry(height * 0.035, height * 2.8),
            new MeshBasicMaterial({ color: 0x9ab8cd }))
        panel.position.set(height * x, floorY + height * 1.4, -height * 1.49)
        group.add(panel)
    }
    return {
        group,
        dispose() {
            wallTexture.dispose()
            grid.geometry.dispose()
            grid.material.dispose()
            group.traverse(object => {
                if (object instanceof Mesh) {
                    object.geometry.dispose()
                    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
                        material.dispose()
                    }
                }
            })
        },
    }
}

export function getCharacterCameraZ(bounds: Box3, aspect: number) {
    const center = bounds.getCenter(new Vector3())
    const tangent = Math.tan(characterFov * Math.PI / 360)
    return bounds.max.z + Math.max(
        (bounds.max.y - center.y) / tangent,
        (bounds.max.x - center.x) / (aspect * tangent)) * 1.04
}

export function getPerspectiveFit(bounds: Box3, cameraZ: number, centerX: number,
    aspect: number) {
    const centerY = (bounds.min.y + bounds.max.y) / 2
    const tangent = Math.tan(characterFov * Math.PI / 360)
    const halfHeight = Math.max(bounds.max.y - centerY,
        Math.abs(bounds.min.x - centerX) / aspect, Math.abs(bounds.max.x - centerX) / aspect) * 1.04
    return {
        zoom: Math.min(1, (cameraZ - bounds.max.z) * tangent / halfHeight),
        centerY,
    }
}

export function prepareCharacterMaterials(root: Group) {
    const materials = new Set<MToonMaterial>()
    root.traverse(object => {
        if (!(object instanceof Mesh)) return
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material instanceof MToonMaterial) materials.add(material)
        }
    })
    for (const material of materials) {
        // Keep authored maps and outlines; white shade factors otherwise erase the light direction.
        material.shadeColorFactor.multiply(new Color().setRGB(0.72, 0.77, 0.86))
        material.shadingToonyFactor = Math.min(material.shadingToonyFactor, 0.55)
        material.giEqualizationFactor = Math.min(material.giEqualizationFactor, 0.35)
        if (!material.isOutline) {
            material.parametricRimColorFactor.setRGB(0.025, 0.035, 0.05)
            material.parametricRimFresnelPowerFactor = 3.5
            material.parametricRimLiftFactor = 0
            material.rimLightingMixFactor = 0
        }
    }
}

export function createCharacterStudio() {
    const studio = new Group()
    studio.add(new HemisphereLight(0xe8f1ff, 0x7d8ba5, 0.5))
    const key = new DirectionalLight(0xfff1e4, 2.1)
    key.position.set(-3, 4, 4)
    studio.add(key)
    return studio
}

export function createContactShadow(modelHeight: number, floorY: number) {
    const resolution = 64
    const pixels = new Uint8Array(resolution * resolution * 4)
    for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
            const radius = Math.hypot((x + 0.5) / resolution * 2 - 1, (y + 0.5) / resolution * 2 - 1)
            pixels[(y * resolution + x) * 4 + 3] =
                Math.round(255 * Math.exp(-radius * radius * 4.5) * Math.max(0, 1 - radius * radius))
        }
    }
    const texture = new DataTexture(pixels, resolution, resolution)
    texture.magFilter = texture.minFilter = LinearFilter
    texture.needsUpdate = true
    const material = new MeshBasicMaterial({
        map: texture, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false,
    })
    const mesh = new Mesh(new PlaneGeometry(modelHeight * 0.48, modelHeight * 0.30), material)
    mesh.rotation.x = -Math.PI / 2
    mesh.renderOrder = 1
    mesh.position.y = floorY + modelHeight * 0.001
    return {
        mesh,
        update(x: number, z: number, lift: number) {
            const height = Math.max(0, lift) / modelHeight
            mesh.position.x = x
            mesh.position.z = z
            mesh.scale.setScalar(1 + Math.min(height, 0.3))
            material.opacity = 0.28 * Math.exp(-height * 8)
        },
        dispose() {
            mesh.geometry.dispose()
            material.dispose()
            texture.dispose()
        },
    }
}
