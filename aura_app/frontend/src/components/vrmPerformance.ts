export type RenderingMode = 'auto' | 'hardware' | 'software'

export function assertHardwareRenderer(mode: RenderingMode, renderer: string) {
    if (mode === 'hardware' && /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(renderer)) {
        throw new Error('GPU 模式实际回退到了软件渲染，请检查显卡驱动；可用 AURA_SOFTWARE_RENDERING=1 恢复安全模式。')
    }
}

export function getNextSoftwareRenderHeight(height: number, fps: number): number {
    if (!Number.isFinite(height) || height < 192 || height > 384 ||
        !Number.isFinite(fps) || fps < 0) throw new Error('Invalid software rendering budget')
    return fps >= 18 ? height : Math.max(192, Math.floor(height * 0.85 / 16) * 16)
}

export function getVrmRenderProfile(mode: RenderingMode) {
    return mode === 'software' ?
        { antialias: false, maxWidth: 256, maxHeight: 384, activeFps: 30, idleFps: 18 } :
        { antialias: true, maxWidth: 512, maxHeight: 1024, activeFps: 60, idleFps: 24 }
}

export function getVrmRenderSize(width: number, height: number,
    profile: ReturnType<typeof getVrmRenderProfile>) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
        throw new Error('Invalid character render dimensions')
    }
    const scale = Math.min(1, profile.maxWidth / Math.max(1, width), profile.maxHeight / Math.max(1, height))
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
