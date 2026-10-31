import type { RenderingMode } from './components/vrmPerformance'

declare global {
    interface Window {
        electron?: {
            renderingMode: RenderingMode
            setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void
        }
    }
}
