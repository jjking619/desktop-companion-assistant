import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MotionValue } from 'framer-motion'
import {
    Box3, DirectionalLight, Group, Mesh, PCFSoftShadowMap, PerspectiveCamera, SkinnedMesh,
    SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { vrmCharacter, idleActions, getIdleActionWeight } from './vrmCharacter'
import type { IdleAction } from './vrmCharacter'
import { createVrmWalk } from './vrmWalking'
import { advanceMouthWeight, getDialogueCameraFrame, getDialoguePose, getSpeechMouthWeights, speechVisemes } from './speechPresentation'
import type { DialogueState, SpeechViseme, MouthWeights } from './speechPresentation'
import { scaleMouthOpening } from './vrmMouth'
import { advanceSoundYaw } from './soundDirection'
import { assertHardwareRenderer, getNextSoftwareRenderHeight, getVrmRenderProfile, getVrmRenderSize } from './vrmPerformance'
import { combineStaticSkinnedPrimitives } from './vrmMeshBatching'
import { characterFov, createCharacterStudio, createContactShadow, createStudioStage, frameGlobalStudio,
    getCharacterCameraZ, getPerspectiveFit, prepareCharacterMaterials } from './vrmPresentation'
import { createVrmPresence } from './vrmPresence'
import { createShadowProxy } from './vrmShadowProxy'

interface VrmCharacterProps {
    language?: 'zh' | 'en'
    walking: boolean
    facing: number
    soundYaw?: number
    distance: MotionValue<number>
    mouthLevel: number
    mouthViseme?: SpeechViseme | null
    mouthWeights?: MouthWeights | null
    idleAction?: IdleAction | null
    onIdleActionEnd?: () => void
    reducedMotion: boolean
    closeup: boolean
    studioBackground: boolean
    position: { x: MotionValue<number>; y: MotionValue<number> }
    dialogueState: DialogueState
    onStatus: (ready: boolean, error?: string) => void
}

const contextLossMessage = 'WebGL 图形上下文已丢失，请重新加载人物；若反复发生，请用 AURA_SOFTWARE_RENDERING=1 重启桌面陪伴助手。'

function readBinary(relative: string, signal: AbortSignal): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest()
        const url = new URL(relative, document.baseURI)
        const abort = () => request.abort()
        request.open('GET', url.href)
        request.responseType = 'arraybuffer'
        request.timeout = 45000
        signal.addEventListener('abort', abort, { once: true })
        request.onloadend = () => signal.removeEventListener('abort', abort)
        request.onload = () => {
            if ((request.status === 200 || (request.status === 0 && url.protocol === 'file:')) &&
                request.response instanceof ArrayBuffer && request.response.byteLength > 0) {
                resolve(request.response)
            } else reject(new Error(`Cannot load ${relative}: HTTP ${request.status}`))
        }
        request.onerror = () => reject(new Error(`Cannot read 3D asset: ${relative}`))
        request.ontimeout = () => reject(new Error(`3D asset timed out: ${relative}`))
        request.onabort = () => reject(new Error('3D asset loading cancelled'))
        if (signal.aborted) reject(new Error('3D asset loading cancelled'))
        else request.send()
    })
}

const VrmCharacter = (props: VrmCharacterProps) => {
    const host = useRef<HTMLDivElement>(null)
    const current = useRef(props)
    const [status, setStatus] = useState('loading')
    useLayoutEffect(() => { current.current = props }, [props])
    const { distance, onStatus } = props

    useEffect(() => {
        const element = host.current!
        const controller = new AbortController()
        let disposed = false
        let failed = false
        let renderer: WebGLRenderer | undefined
        let stageRenderer: WebGLRenderer | undefined
        let keyLight: DirectionalLight | undefined
        let stageKeyLight: DirectionalLight | undefined
        let shadowProxy: ReturnType<typeof createShadowProxy> | undefined
        let vrm: VRM | undefined
        let walk: ReturnType<typeof createVrmWalk> | undefined
        let observer: ResizeObserver | undefined
        let shadow: ReturnType<typeof createContactShadow> | undefined
        let stage: ReturnType<typeof createStudioStage> | undefined
        let resizeRenderer: (() => void) | undefined
        const footShadows: ReturnType<typeof createContactShadow>[] = []
        let pointer: { x: number; y: number; time: number } | null = null
        const pointerMove = (event: PointerEvent) => {
            if (event.pointerType === 'touch') return
            const rect = element.getBoundingClientRect()
            pointer = {
                x: (event.clientX - rect.left - rect.width / 2) / Math.max(1, rect.width),
                y: (rect.top + rect.height * 0.3 - event.clientY) / Math.max(1, rect.height / 2),
                time: performance.now(),
            }
        }
        const clearPointer = () => { pointer = null }
        const pointerOut = (event: PointerEvent) => {
            if (!event.relatedTarget) clearPointer()
        }
        window.addEventListener('pointermove', pointerMove)
        window.addEventListener('pointerout', pointerOut)
        window.addEventListener('blur', clearPointer)
        let requestId = 0
        const fail = (error: unknown) => {
            if (disposed || failed) return
            failed = true
            cancelAnimationFrame(requestId)
            const message = error instanceof Error ? error.message : String(error)
            console.error('[AURA real-time VRM]', error)
            element.dataset.error = message
            setStatus('error')
            onStatus(false, message)
        }
        const contextLost = (event: Event) => {
            event.preventDefault()
            const canvas = event.currentTarget
            console.error('[AURA graphics] WebGL context lost', {
                time: new Date().toISOString(),
                canvas: canvas instanceof HTMLCanvasElement ?
                    canvas.dataset.auraStageRenderer !== undefined ? 'stage' : 'character' : 'unknown',
                renderer: element.dataset.renderer,
                backend: window.electron?.renderingMode ?? 'auto',
                characterState: element.dataset.renderState,
                stageContextLost: stageRenderer?.getContext().isContextLost() ?? false,
                characterContextLost: renderer?.getContext().isContextLost() ?? false,
                eventType: event.type,
                cancelable: event.cancelable,
            })
            fail(new Error(contextLossMessage))
        }
        const initialize = async () => {
            const profile = getVrmRenderProfile(window.electron?.renderingMode ?? 'auto')
            element.dataset.renderProfile = window.electron?.renderingMode ?? 'auto'
            renderer = new WebGLRenderer({ alpha: true, antialias: profile.antialias, powerPreference: 'high-performance' })
            const gl = renderer.getContext()
            const debug = gl.getExtension('WEBGL_debug_renderer_info')
            element.dataset.renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
            element.dataset.antialias = String(gl.getContextAttributes()?.antialias)
            assertHardwareRenderer(window.electron?.renderingMode ?? 'auto', element.dataset.renderer)
            renderer.setPixelRatio(1)
            renderer.setClearColor(0x000000, 0)
            renderer.outputColorSpace = SRGBColorSpace
            renderer.domElement.style.cssText = 'width:100%;height:100%;display:block'
            renderer.domElement.dataset.auraRenderer = ''
            renderer.domElement.addEventListener('webglcontextlost', contextLost)
            element.appendChild(renderer.domElement)
            const loader = new GLTFLoader()
            loader.register(parser => new VRMLoaderPlugin(parser))
            const modelData = await readBinary(vrmCharacter.model, controller.signal)
            if (disposed) return
            const loaded = await loader.parseAsync(modelData, '')
            const avatar: unknown = loaded.userData.vrm
            if (!(avatar instanceof VRM)) throw new Error('Asset is not a VRM humanoid')
            vrm = avatar
            element.dataset.loadStage = 'preparing-model'
            if (disposed) { VRMUtils.deepDispose(vrm.scene); return }
            VRMUtils.rotateVRM0(vrm)
            for (const shape of speechVisemes) {
                if (!vrm.expressionManager?.getExpression(shape)) {
                    throw new Error(`VRM is missing the ${shape} mouth expression`)
                }
            }
            scaleMouthOpening(vrm.expressionManager?.getExpression('aa'), vrmCharacter.mouthOpeningScale)
            // Compact only after editing morph targets: compaction replaces their attributes.
            VRMUtils.removeUnnecessaryVertices(vrm.scene)
            VRMUtils.combineMorphs(vrm)
            VRMUtils.combineSkeletons(vrm.scene)
            combineStaticSkinnedPrimitives(vrm.scene)
            const root = new Group()
            root.add(vrm.scene)
            const scene = new Group()
            prepareCharacterMaterials(root)
            const lighting = createCharacterStudio()
            scene.add(root, lighting)
            const motionData = await readBinary(vrmCharacter.motion, controller.signal)
            if (disposed) return
            const motion = await loader.parseAsync(motionData, '')
            if (disposed) { VRMUtils.deepDispose(motion.scene); return }
            walk = createVrmWalk(vrm, motion)
            element.dataset.loadStage = 'framing'
            VRMUtils.deepDispose(motion.scene)
            const bounds = new Box3()
            for (const angle of [0, -Math.PI / 2, Math.PI / 2]) {
                for (let frame = 0; frame < (angle === 0 ? 1 : 16); frame++) {
                    root.rotation.y = 0
                    walk.apply(frame / 16, angle === 0 ? 0 : 1)
                    root.rotation.y = angle
                    vrm.update(0)
                    root.updateMatrixWorld(true)
                    bounds.expandByObject(root, true)
                }
            }
            const idleBounds = new Map<IdleAction, Box3>()
            for (const name of idleActions) {
                const actionBounds = new Box3()
                const duration = walk.getIdleDuration(name)
                for (let frame = 0; frame <= 12; frame++) {
                    const elapsed = duration * frame / 12
                    root.rotation.y = 0
                    walk.applyIdle(name, elapsed, getIdleActionWeight(elapsed, duration))
                    vrm.update(0)
                    root.updateMatrixWorld(true)
                    actionBounds.expandByObject(root, true)
                }
                idleBounds.set(name, actionBounds)
            }
            const size = bounds.getSize(new Vector3())
            element.dataset.loadStage = 'rendering'
            const walkingBounds = bounds.clone()
            walk.apply(0, 0)
            vrm.update(0)
            root.rotation.y = 0
            root.updateMatrixWorld(true)
            bounds.setFromObject(root, true)
            size.copy(bounds.getSize(new Vector3()))
            const center = bounds.getCenter(new Vector3())
            const aspect = vrmCharacter.width / vrmCharacter.height
            const cameraZ = getCharacterCameraZ(bounds, aspect)
            const walkingFrame = getPerspectiveFit(walkingBounds, cameraZ, center.x, aspect)
            const idleFrames = new Map(idleActions.map(name => {
                const actionBounds = idleBounds.get(name)!
                return [name, getPerspectiveFit(actionBounds, cameraZ, center.x, aspect)] as const
            }))
            const camera = new PerspectiveCamera(characterFov, aspect, 0.01, cameraZ + size.y * 64)
            walk.apply(0, 0)
            root.rotation.y = 0
            vrm.update(0)
            root.updateMatrixWorld(true)
            const head = vrm.humanoid.getNormalizedBoneNode('head')
            if (!head) throw new Error('VRM humanoid is missing the head bone')
            const headPosition = head.getWorldPosition(new Vector3())
            const perspectiveHalfHeight = (cameraZ - center.z) * Math.tan(characterFov * Math.PI / 360)
            const closeupFrame = getDialogueCameraFrame(size.y, perspectiveHalfHeight, bounds.max.y, headPosition.y)
            closeupFrame.zoom = Math.min(closeupFrame.zoom,
                0.90 * (cameraZ - bounds.max.z) * Math.tan(characterFov * Math.PI / 360) /
                (bounds.max.y - closeupFrame.centerY))
            camera.position.set(center.x, center.y, cameraZ)
            camera.lookAt(center)
            const studioCamera = camera.clone()
            const stageOffset = new Vector3()
            const stageScene = new Group()
            const stageLighting = createCharacterStudio()
            stageScene.add(stageLighting)
            shadow = createContactShadow(size.y, bounds.min.y)
            scene.add(shadow.mesh)
            stage = createStudioStage(size.y, bounds.min.y)
            stage.group.position.set(center.x, 0, center.z)
            stageScene.add(stage.group)
            const key = lighting.children.find(light => light instanceof DirectionalLight)!
            key.position.set(center.x - size.y * 2, bounds.min.y + size.y * 3, center.z + size.y * 2)
            key.target.position.set(center.x, center.y, center.z)
            scene.add(key.target)
            key.shadow.mapSize.set(512, 512)
            key.shadow.camera.left = key.shadow.camera.bottom = -size.y * 1.2
            key.shadow.camera.right = key.shadow.camera.top = size.y * 1.2
            key.shadow.camera.near = size.y * 0.1
            key.shadow.camera.far = size.y * 8
            key.shadow.normalBias = size.y * 0.002
            key.shadow.bias = -0.0002
            keyLight = key
            const stageKey = stageLighting.children.find(light => light instanceof DirectionalLight)!
            stageKey.copy(key)
            stageKey.target = key.target.clone()
            stageScene.add(stageKey.target)
            stageKeyLight = stageKey
            vrm.scene.traverse(object => { if (object instanceof Mesh) object.castShadow = true })
            const feet = [vrm.humanoid.getNormalizedBoneNode('leftFoot'),
                vrm.humanoid.getNormalizedBoneNode('rightFoot')].filter(node => node !== null)
            const footPosition = new Vector3()
            const footCenter = new Vector3()
            for (const foot of feet) footCenter.add(foot.getWorldPosition(footPosition))
            if (feet.length) footCenter.divideScalar(feet.length)
            for (const foot of feet) {
                const contact = createContactShadow(size.y * 0.28, bounds.min.y + size.y * 0.0005)
                foot.getWorldPosition(footPosition)
                contact.update(footPosition.x, footPosition.z, 0)
                footShadows.push(contact)
                scene.add(contact.mesh)
            }
            const restFootY = footCenter.y
            shadow.update(center.x, center.z, 0)
            const presence = createVrmPresence(vrm)
            element.dataset.cameraType = 'perspective'
            element.dataset.contactShadow = 'texture'
            element.dataset.presenceExpression = presence.expression
            element.dataset.eyeTracking = String(Boolean(vrm.lookAt))
            const resize = () => {
                const rect = element.getBoundingClientRect()
                const size = getVrmRenderSize(rect.width, rect.height, profile)
                renderer!.setSize(size.width, size.height, false)
                if (stageRenderer) {
                    stageRenderer.setSize(Math.max(1, Math.round(innerWidth * size.height / Math.max(1, rect.height))),
                        Math.max(1, Math.round(innerHeight * size.height / Math.max(1, rect.height))), false)
                }
                element.dataset.renderMaxHeight = String(profile.maxHeight)
            }
            resizeRenderer = resize
            window.addEventListener('resize', resize)
            observer = new ResizeObserver(resize)
            observer.observe(element)
            resize()
            element.dataset.model = vrmCharacter.model
            element.dataset.materials = 'MToon'
            element.dataset.textureQuality = 'original'
            element.dataset.mouthOpeningScale = String(vrmCharacter.mouthOpeningScale)
            const skeletons = new Set()
            let meshCount = 0
            let morphCount = 0
            let vertices = 0
            vrm.scene.traverse(object => {
                if (object instanceof Mesh) {
                    meshCount++
                    vertices += object.geometry.getAttribute('position').count
                    morphCount = Math.max(morphCount, object.geometry.morphAttributes.position?.length ?? 0)
                }
                if (object instanceof SkinnedMesh) skeletons.add(object.skeleton)
            })
            element.dataset.modelMeshes = String(meshCount)
            element.dataset.modelVertices = String(vertices)
            element.dataset.maxMorphs = String(morphCount)
            element.dataset.skeletons = String(skeletons.size)
            let previous = 0
            let frames = 0
            let fpsStart = 0
            let fpsFrames = 0
            let budgetStarted = 0
            let budgetFrames = 0
            let lastMouth = -1
            let lastBackground = current.current.studioBackground
            let settleUntil = 0
            let weight = 0
            let angle = 0
            let soundYaw = 0
            let viewBlend = 0
            let activeIdle: IdleAction | null = null
            let idleElapsed = 0
            let idleFinished = false
            let idleZoom = 1
            let idleCenterY = center.y
            const mouthBlends = getSpeechMouthWeights(0)
            let dialogueState: DialogueState = 'idle'
            let dialogueStarted = 0
            let lastRect = element.getBoundingClientRect()
            let stageUpdated = -Infinity
            let stageView = ''
            let stageFrames = 0
            const dialoguePose = { pitch: 0, yaw: 0, roll: 0 }
            const render = (now: number) => {
                if (disposed || failed) return
                requestId = requestAnimationFrame(render)
                const mouthAnimating = current.current.mouthLevel > 0 ||
                    speechVisemes.some(shape => mouthBlends[shape] > 0)
                if (document.hidden || now - previous < 1000 /
                    (mouthAnimating ? profile.activeFps : profile.idleFps)) return
                const mouth = current.current.mouthLevel
                const mouthTargets = getSpeechMouthWeights(mouth, current.current.mouthViseme,
                    current.current.mouthWeights)
                const closeup = current.current.closeup && !current.current.walking
                const targetSoundYaw = current.current.walking || current.current.reducedMotion ?
                    0 : current.current.soundYaw ?? 0
                const rect = element.getBoundingClientRect()
                if (rect.x !== lastRect.x || rect.y !== lastRect.y ||
                    rect.width !== lastRect.width || rect.height !== lastRect.height) settleUntil = now + 1000
                lastRect = rect
                if (current.current.studioBackground !== lastBackground || !current.current.reducedMotion ||
                    Math.abs(mouth - lastMouth) > 0.005 || current.current.walking ||
                    current.current.dialogueState !== 'idle' || dialogueState !== current.current.dialogueState ||
                    Object.values(dialoguePose).some(value => Math.abs(value) > 0.001) ||
                    current.current.idleAction || activeIdle || weight > 0 ||
                    Math.abs(idleZoom - 1) > 0.001 || Math.abs(idleCenterY - center.y) > 0.001 ||
                    Math.abs(viewBlend - (closeup ? 1 : 0)) > 0.001 ||
                    Math.abs(soundYaw - targetSoundYaw) > 0.001 ||
                    speechVisemes.some(shape => Math.abs(mouthBlends[shape] - mouthTargets[shape]) > 0.005)) settleUntil = now + 1000
                if (now > settleUntil && now - previous < 1000) return
                const delta = (now - (previous || now)) / 1000
                previous = now
                try {
                    const frameStarted = performance.now()
                    const state = current.current
                    if (state.studioBackground !== lastBackground) resize()
                    lastBackground = state.studioBackground
                    stage!.group.visible = false
                    key.castShadow = state.studioBackground && window.electron?.renderingMode !== 'software'
                    if (state.dialogueState !== dialogueState) {
                        dialogueState = state.dialogueState
                        dialogueStarted = now
                    }
                    const walking = state.walking && !state.reducedMotion
                    const idle = !walking && !closeup && !state.reducedMotion ? state.idleAction ?? null : null
                    if (idle !== activeIdle) {
                        activeIdle = idle
                        idleElapsed = 0
                        idleFinished = false
                    }
                    weight += ((walking ? 1 : 0) - weight) * Math.min(1, delta * 14)
                    if (weight < 0.001) weight = 0
                    const targetAngle = walking ? (state.facing < 0 ? -Math.PI / 2 : Math.PI / 2) : 0
                    angle += (targetAngle - angle) * Math.min(1, delta * 10)
                    root.rotation.y = 0
                    if (idle) {
                        const duration = walk!.getIdleDuration(idle)
                        idleElapsed += delta
                        walk!.applyIdle(idle, idleElapsed, getIdleActionWeight(idleElapsed, duration))
                        if (idleElapsed >= duration && !idleFinished) {
                            idleFinished = true
                            state.onIdleActionEnd?.()
                        }
                    } else walk!.apply(distance.get() / vrmCharacter.stride, weight)
                    soundYaw = advanceSoundYaw(soundYaw, targetSoundYaw, delta)
                    const neck = vrm!.humanoid.getNormalizedBoneNode('neck')
                    const pose = getDialoguePose(dialogueState, (now - dialogueStarted) / 1000,
                        mouth, state.reducedMotion || walking || idle !== null)
                    const poseBlend = state.reducedMotion ? 1 : 1 - Math.exp(-delta * 9)
                    for (const axis of ['pitch', 'yaw', 'roll'] as const) {
                        dialoguePose[axis] += (pose[axis] - dialoguePose[axis]) * poseBlend
                    }
                    head.rotation.x += dialoguePose.pitch
                    head.rotation.y += dialoguePose.yaw
                    head.rotation.z += dialoguePose.roll
                    head.rotation.y += soundYaw * (neck ? 0.75 : 1)
                    if (neck) neck.rotation.y += soundYaw * 0.25
                    const life = presence.update({
                        time: now / 1000, delta, state: dialogueState, mouth,
                        reducedMotion: state.reducedMotion, blocked: walking || idle !== null || weight > 0.01,
                        soundYaw,
                        pointer: pointer && now - pointer.time < 4000 ? pointer : null,
                    })
                    root.rotation.y = angle
                    viewBlend = state.reducedMotion ? (closeup ? 1 : 0) :
                        viewBlend + ((closeup ? 1 : 0) - viewBlend) * (1 - Math.exp(-delta * 9))
                    if (Math.abs(viewBlend - (closeup ? 1 : 0)) < 0.001) viewBlend = closeup ? 1 : 0
                    const idleFrame = idle ? idleFrames.get(idle)! : {
                        zoom: 1 + (walkingFrame.zoom - 1) * weight,
                        centerY: center.y + (walkingFrame.centerY - center.y) * weight,
                    }
                    const framingBlend = 1 - Math.exp(-delta * 14)
                    idleZoom += (idleFrame.zoom - idleZoom) * framingBlend
                    idleCenterY += (idleFrame.centerY - idleCenterY) * framingBlend
                    camera.zoom = (1 + viewBlend * (closeupFrame.zoom - 1)) * idleZoom
                    camera.position.y = idleCenterY + (closeupFrame.centerY - idleCenterY) * viewBlend
                    camera.lookAt(center.x, camera.position.y, center.z)
                    camera.updateProjectionMatrix()
                    for (const shape of speechVisemes) {
                        const target = mouthTargets[shape]
                        mouthBlends[shape] = advanceMouthWeight(mouthBlends[shape], target, delta)
                        vrm!.expressionManager?.setValue(shape, mouthBlends[shape])
                    }
                    const poseEnded = performance.now()
                    // Bound spring physics without slowing the speech or gesture clocks.
                    vrm!.update(state.reducedMotion ? 0 : Math.min(delta, 0.1))
                    footCenter.set(0, 0, 0)
                    for (const foot of feet) footCenter.add(foot.getWorldPosition(footPosition))
                    if (feet.length) {
                        footCenter.divideScalar(feet.length)
                        shadow!.update(footCenter.x, footCenter.z, footCenter.y - restFootY)
                    }
                    feet.forEach((foot, index) => {
                        foot.getWorldPosition(footPosition)
                        footShadows[index].update(footPosition.x, footPosition.z, footPosition.y - restFootY)
                    })
                    const updateEnded = performance.now()
                    if (window.electron?.renderingMode === 'software' && mouthAnimating) {
                        if (!budgetStarted) budgetStarted = now
                        budgetFrames++
                        if (now - budgetStarted >= 1000) {
                            const height = getNextSoftwareRenderHeight(profile.maxHeight,
                                budgetFrames * 1000 / (now - budgetStarted))
                            if (height !== profile.maxHeight) {
                                profile.maxHeight = height
                                resize()
                            }
                            budgetStarted = now
                            budgetFrames = 0
                        }
                    } else {
                        budgetStarted = 0
                        budgetFrames = 0
                    }
                    if (state.studioBackground) {
                        const target = document.querySelector<HTMLElement>('[data-aura-studio-background]')
                        if (!target) throw new Error('全局 3D 场景容器不存在，请重新加载人物。')
                        if (!stageRenderer) {
                            stageRenderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
                            stageRenderer.outputColorSpace = SRGBColorSpace
                            stageRenderer.setClearColor(0x243746)
                            stageRenderer.shadowMap.enabled = window.electron?.renderingMode !== 'software'
                            stageRenderer.shadowMap.type = PCFSoftShadowMap
                            stageRenderer.shadowMap.autoUpdate = false
                            stageRenderer.domElement.dataset.auraStageRenderer = ''
                            stageRenderer.domElement.addEventListener('webglcontextlost', contextLost)
                            resize()
                        }
                        if (stageRenderer.domElement.parentElement !== target) {
                            target.appendChild(stageRenderer.domElement)
                            stageUpdated = -Infinity
                        }
                        const position = current.current.position
                        const anchor = { x: rect.x - position.x.get(), y: rect.y - position.y.get(),
                            width: rect.width, height: rect.height }
                        const view = [rect.x, rect.y, anchor.x, anchor.y, rect.width, rect.height,
                            innerWidth, innerHeight].join(',')
                        // Moving the avatar must not turn full-window shadow rendering into a per-frame pass.
                        if (stageUpdated === -Infinity || (now - stageUpdated >= 200 &&
                            (view !== stageView || !state.reducedMotion))) {
                            frameGlobalStudio(studioCamera, anchor, innerWidth, innerHeight, 1)
                            if (key.castShadow) {
                                shadowProxy ??= createShadowProxy(root)
                                if (shadowProxy.group.parent !== stageScene) stageScene.add(shadowProxy.group)
                                const unitsPerPixel = 2 * perspectiveHalfHeight / Math.max(1, rect.height)
                                stageOffset.set(position.x.get() * unitsPerPixel,
                                    -position.y.get() * unitsPerPixel, 0)
                                shadowProxy.update(stageOffset)
                                stageKey.position.copy(key.position).add(stageOffset)
                                stageKey.target.position.copy(key.target.position).add(stageOffset)
                                stageKey.castShadow = true
                                stage!.group.visible = false
                                shadowProxy.group.visible = true
                                stageRenderer.setScissorTest(true)
                                stageRenderer.setScissor(0, 0, 1, 1)
                                stageRenderer.shadowMap.needsUpdate = true
                                stageRenderer.render(stageScene, studioCamera)
                                stageRenderer.setScissorTest(false)
                                shadowProxy.group.visible = false
                            }
                            stageKey.castShadow = key.castShadow
                            stage!.group.visible = true
                            stageRenderer.render(stageScene, studioCamera)
                            stageView = view
                            stageUpdated = now
                            stageFrames++
                        }
                    }
                    renderer!.render(scene, camera)
                    const drawEnded = performance.now()
                    element.dataset.frameMs = (drawEnded - frameStarted).toFixed(1)
                    lastMouth = mouth
                    if (renderer!.getContext().isContextLost() || stageRenderer?.getContext().isContextLost()) {
                        throw new Error(contextLossMessage)
                    }
                    frames++
                    fpsFrames++
                    element.dataset.renderedFrames = String(frames)
                    element.dataset.studioBackground = state.studioBackground ? 'studio' : 'transparent'
                    element.dataset.studioGeometry = state.studioBackground ? 'shared-3d' : 'none'
                    element.dataset.studioSkinning = 'isolated-gpu-shadow'
                    element.dataset.projectedShadow = String(key.castShadow)
                    element.dataset.studioRenderedFrames = String(stageFrames)
                    element.dataset.walking = String(walking)
                    element.dataset.soundYaw = String(soundYaw)
                    element.dataset.headYaw = String(head.rotation.y)
                    element.dataset.presenceHeadYaw = String(life.headYaw)
                    element.dataset.presenceHeadPitch = String(life.headPitch)
                    element.dataset.gazeYaw = String(life.gazeYaw)
                    element.dataset.gazePitch = String(life.gazePitch)
                    element.dataset.leftEyeYaw = String(vrm!.humanoid.getRawBoneNode('leftEye')?.rotation.y ?? 0)
                    element.dataset.breathing = String(life.breathing)
                    element.dataset.blink = String(life.blink)
                    element.dataset.presenceExpressionWeight = String(life.expressionWeight)
                    element.dataset.chestPitch = String((vrm!.humanoid.getNormalizedBoneNode('upperChest') ??
                        vrm!.humanoid.getNormalizedBoneNode('chest'))?.rotation.x ?? 0)
                    element.dataset.dialogueState = dialogueState
                    element.dataset.dialoguePitch = String(dialoguePose.pitch)
                    element.dataset.dialogueRoll = String(dialoguePose.roll)
                    element.dataset.neckYaw = String(neck?.rotation.y ?? 0)
                    element.dataset.idleAction = idle ?? 'none'
                    element.dataset.walkCycle = String(distance.get() / vrmCharacter.stride)
                    element.dataset.direction = walking ? (state.facing < 0 ? 'left' : 'right') : 'front'
                    element.dataset.kneeRotation = String(vrm!.humanoid.getNormalizedBoneNode('leftLowerLeg')!.quaternion.x)
                    element.dataset.leftArmZ = String(vrm!.humanoid.getNormalizedBoneNode('leftUpperArm')!.rotation.z)
                    element.dataset.rightArmZ = String(vrm!.humanoid.getNormalizedBoneNode('rightUpperArm')!.rotation.z)
                    element.dataset.leftElbowY = String(vrm!.humanoid.getNormalizedBoneNode('leftLowerArm')!.rotation.y)
                    element.dataset.expressionAa = String(vrm!.expressionManager?.getValue('aa') ?? 0)
                    element.dataset.expressionIh = String(vrm!.expressionManager?.getValue('ih') ?? 0)
                    element.dataset.expressionOu = String(vrm!.expressionManager?.getValue('ou') ?? 0)
                    element.dataset.expressionEe = String(vrm!.expressionManager?.getValue('ee') ?? 0)
                    element.dataset.expressionOh = String(vrm!.expressionManager?.getValue('oh') ?? 0)
                    element.dataset.cameraZoom = String(camera.zoom)
                    element.dataset.headScreenY = String(
                        headPosition.clone().project(camera).y)
                    element.dataset.headTopScreenY = String(
                        new Vector3(headPosition.x, bounds.max.y, headPosition.z).project(camera).y)
                    element.dataset.view = closeup ? 'dialogue-closeup' : 'full-body'
                    if (now - fpsStart >= 1000) {
                        element.dataset.poseMs = (poseEnded - frameStarted).toFixed(1)
                        element.dataset.updateMs = (updateEnded - poseEnded).toFixed(1)
                        element.dataset.drawMs = (drawEnded - updateEnded).toFixed(1)
                        element.dataset.drawCalls = String(renderer!.info.render.calls)
                        element.dataset.triangles = String(renderer!.info.render.triangles)
                        element.dataset.fps = (fpsFrames * 1000 / (now - fpsStart)).toFixed(1)
                        fpsStart = now
                        fpsFrames = 0
                    }
                    if (frames === 1) { setStatus('ready'); onStatus(true) }
                } catch (error) { fail(error) }
            }
            requestId = requestAnimationFrame(render)
        }
        void initialize().catch(fail)
        return () => {
            disposed = true
            controller.abort()
            cancelAnimationFrame(requestId)
            observer?.disconnect()
            if (resizeRenderer) window.removeEventListener('resize', resizeRenderer)
            window.removeEventListener('pointermove', pointerMove)
            window.removeEventListener('pointerout', pointerOut)
            window.removeEventListener('blur', clearPointer)
            walk?.dispose()
            shadow?.dispose()
            stage?.dispose()
            keyLight?.dispose()
            stageKeyLight?.dispose()
            shadowProxy?.dispose()
            for (const contact of footShadows) contact.dispose()
            if (vrm) VRMUtils.deepDispose(vrm.scene)
            if (renderer) {
                renderer.domElement.removeEventListener('webglcontextlost', contextLost)
                renderer.dispose()
                renderer.forceContextLoss()
                renderer.domElement.remove()
            }
            if (stageRenderer) {
                stageRenderer.domElement.removeEventListener('webglcontextlost', contextLost)
                stageRenderer.dispose()
                stageRenderer.forceContextLoss()
                stageRenderer.domElement.remove()
            }
        }
    }, [distance, onStatus])

    return <div ref={host} data-aura-vrm data-render-state={status}
        data-aura-mouth={props.mouthLevel > 0.08 && props.mouthViseme !== null ? 'open' : 'closed'}
        data-mouth-viseme={props.mouthViseme === null ? 'closed' : props.mouthViseme ?? 'aa'}
        data-mouth-level={props.mouthLevel.toFixed(2)} className="absolute inset-0">
        {status === 'loading' && <div role="status" className="absolute inset-0 flex items-center justify-center text-cyan-200">
            {props.language === 'en' ? 'Loading 3D character…' : '正在加载 3D 人物…'}
        </div>}
    </div>
}

export default VrmCharacter
