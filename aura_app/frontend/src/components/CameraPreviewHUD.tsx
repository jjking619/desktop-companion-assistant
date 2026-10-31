import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { EyeOff } from 'lucide-react'
import type { Language } from '../uiLanguage'
import { displayText } from '../uiLanguage'
import { systemMessage } from '../systemMessages'

interface GestureTelemetry {
    gesture?: string
    gesture_backend?: string
    gesture_event?: { id: number, gesture: string, command?: string } | null
    perception_error?: string | null
    fps?: number
    swipe_locked?: boolean
}

const gestureLabels: Record<string, Record<Language, string>> = {
    none: { zh: '未识别到手势', en: 'No gesture detected' },
    open_palm: { zh: '张开手掌', en: 'Open palm' },
    closed_fist: { zh: '握拳', en: 'Closed fist' },
    pointing: { zh: '食指指向', en: 'Index pointing' },
    shoosh: { zh: '嘘声手势', en: 'Shush' },
    peace: { zh: '剪刀手', en: 'Peace sign' },
    thumbs_up: { zh: '点赞', en: 'Thumbs up' },
    swipe_up: { zh: '向上滑动', en: 'Swipe up' },
    swipe_down: { zh: '向下滑动', en: 'Swipe down' },
}
const label = (gesture: string, lang: Language) => gestureLabels[gesture]?.[lang] ?? gesture

interface CameraPreviewHUDProps {
    isOpen: boolean
    onClose: () => void
    language?: Language
}

const CameraPreviewHUD = ({ isOpen, onClose, language = 'zh' }: CameraPreviewHUDProps) => {
    const strings = language === 'en' ? {
        title: 'Gesture preview',
        waiting: 'Waiting for backend or recognition data…',
        error: (msg: string) => `Recognition error: ${msg}`,
        disabled: 'Gesture camera is disabled. Enable AURA_GESTURE_VOLUME=1 and restart.',
        failed: 'Camera preview failed. Check the backend or camera.',
        current: 'Current:',
        waitingValue: 'Waiting',
        unavailable: 'Unavailable',
        disabledValue: 'Disabled',
        recent: 'Recent action:',
        none: 'None',
        swipeLocked: 'Adjusted — retract your finger and swipe again',
        swipeHint: 'Extend your index finger and swipe up/down; after release or leaving the frame for 300 ms, it can be adjusted again',
        fps: 'FPS',
        upDown: 'Swipe up +5%, swipe down -5%; check the actual volume in the dock below.',
        reconnect: 'Reconnect stream',
        status: 'Gesture preview',
    } : {
        title: '手势识别预览',
        waiting: '等待后端连接或识别数据…',
        error: (msg: string) => `识别错误：${msg}`,
        disabled: '手势摄像头未启用，请设置 AURA_GESTURE_VOLUME=1 后重启。',
        failed: '摄像头预览连接失败，请检查后端或摄像头。',
        current: '当前：',
        waitingValue: '等待数据',
        unavailable: '识别不可用',
        disabledValue: '未启用',
        recent: '最近动作：',
        none: '暂无',
        swipeLocked: '已调节，请收指后再滑',
        swipeHint: '伸出食指上下滑动；收指或离开画面 300 毫秒后可再次调节',
        fps: '识别帧率：',
        upDown: '上滑 +5%，下滑 -5%；实际音量见下方 Dock。',
        reconnect: '重新连接画面',
        status: '手势识别预览',
    }
    const [telemetry, setTelemetry] = useState<GestureTelemetry | null>(null)
    const [connected, setConnected] = useState(false)
    const [feedError, setFeedError] = useState(false)
    const [feedGeneration, setFeedGeneration] = useState(0)
    const feed = useRef<HTMLImageElement>(null)
    useEffect(() => {
        let lastReceived = 0
        const receive = (event: Event) => {
            const data = (event as CustomEvent<GestureTelemetry | null>).detail
            lastReceived = performance.now()
            setConnected(data !== null)
            setTelemetry(data)
        }
        window.addEventListener('aura-perception', receive)
        const timer = setInterval(() => {
            if (lastReceived && performance.now() - lastReceived > 3000) setConnected(false)
        }, 500)
        return () => {
            window.removeEventListener('aura-perception', receive)
            clearInterval(timer)
        }
    }, [])
    const enabled = connected && telemetry?.gesture_backend !== 'disabled' && Boolean(telemetry?.gesture_backend)
    const error = telemetry?.perception_error ? displayText(systemMessage(telemetry.perception_error), language) : null
    const event = connected ? telemetry?.gesture_event : null
    const fps = telemetry?.fps
    useEffect(() => {
        const image = feed.current
        if (isOpen && enabled && !feedError) image?.setAttribute('src', 'http://127.0.0.1:8000/video_feed')
        // Abort the MJPEG request rather than relying on removal of the DOM node.
        return () => image?.removeAttribute('src')
    }, [isOpen, enabled, feedError, feedGeneration])
    if (!isOpen) return null

    return (
        <motion.div
            data-aura-interactive
            role="region"
            aria-label={strings.title}
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            className="fixed top-12 right-6 w-72 max-w-[calc(100vw-24px)] max-h-[calc(100vh-160px)] overflow-y-auto bg-black/90 border border-cyan-500/30 rounded-2xl p-2.5 z-40 pointer-events-auto flex flex-col gap-2"
        >
            <div className="flex items-center justify-between px-2 pt-1 text-[11px] font-mono text-cyan-300">
                <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider">
                    {strings.title}
                </span>
                <button
                    onClick={onClose}
                    aria-label={language === 'en' ? 'Close preview' : '关闭手势预览'}
                    className="p-1 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition"
                >
                    <EyeOff size={14} />
                </button>
            </div>

            <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-black/80 border border-white/10">
                {enabled && !feedError ? <img
                    ref={feed}
                    key={feedGeneration}
                    alt={language === 'en' ? 'Camera view for hand gesture recognition' : '摄像头手部骨架与识别画面'}
                    onError={() => {
                        console.error('[AURA gesture preview] Camera stream failed')
                        setFeedError(true)
                    }}
                    className="w-full h-full object-contain"
                /> : <p role={error || feedError ? 'alert' : 'status'}
                    className="p-3 text-sm text-cyan-100">
                    {!connected ? strings.waiting : error ? strings.error(error) :
                        !enabled ? strings.disabled : strings.failed}
                </p>}
                {error && enabled && !feedError && <p role="alert"
                    className="absolute inset-0 bg-black/80 p-3 text-sm text-red-200">
                    {strings.error(error)}
                </p>}
            </div>
            <div className="px-2 text-xs text-cyan-100 space-y-1">
                <p>{strings.current}{!connected ? strings.waitingValue : error ? strings.unavailable :
                    !enabled ? strings.disabledValue : label(telemetry?.gesture ?? 'none', language)}</p>
                <p>{strings.recent}{event ? `${label(event.gesture, language)}（#${event.id}）` : strings.none}</p>
                {connected && enabled && !error && <p role="status">
                    {telemetry?.swipe_locked ? strings.swipeLocked : strings.swipeHint}
                </p>}
                <p>{strings.fps}{connected && typeof fps === 'number' && Number.isFinite(fps) ? fps.toFixed(1) : '—'} FPS</p>
                <p>{strings.upDown}</p>
                <button type="button" className="text-cyan-300 underline" onClick={() => {
                    setFeedError(false)
                    setFeedGeneration(value => value + 1)
                }}>{strings.reconnect}</button>
            </div>
        </motion.div>
    )
}

export default CameraPreviewHUD
