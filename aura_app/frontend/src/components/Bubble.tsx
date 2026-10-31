import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { animate, motion, useMotionValue } from 'framer-motion'
import { Wifi, WifiOff, Volume2 } from 'lucide-react'
import VrmCharacter from './VrmCharacter'
import { vrmCharacter } from './vrmCharacter'
import { getSpeechMouthLevel } from './speechPresentation'
import type { SpeechAudioState } from './speechPresentation'
import { parseSoundDirection, soundYawRadians } from './soundDirection'
import type { SoundDirection } from './soundDirection'
import { bilingual, displayText } from '../uiLanguage'
import type { DisplayText, Language } from '../uiLanguage'
import { isTtsSynthesisFailure, systemMessage } from '../systemMessages'

interface BubbleProps {
    dialogueCloseup?: boolean
    studioBackground: boolean
    onListen: () => void
    isThinking?: boolean
    audioState?: SpeechAudioState
    language?: Language
}

const Bubble = ({ audioState, isThinking = false, onListen, dialogueCloseup = true, studioBackground, language = 'zh' }: BubbleProps) => {
    const [isHovered, setIsHovered] = useState(false)
    const [isConnected, setIsConnected] = useState(false)
    const [bubbleText, setBubbleText] = useState<DisplayText>(() => bilingual('连接中…', 'Connecting…'))
    const [isDragging, setIsDragging] = useState(false)
    const [keyboardFocused, setKeyboardFocused] = useState(false)
    const [isWalking, setIsWalking] = useState(false)
    const [renderError, setRenderError] = useState('')
    const [modelReady, setModelReady] = useState(false)
    const [modelGeneration, setModelGeneration] = useState(0)
    const [soundDirection, setSoundDirection] = useState<SoundDirection | null>(null)
    const [soundError, setSoundError] = useState<DisplayText>('')
    const lastSoundTelemetry = useRef(0)
    const handleModelStatus = useCallback((ready: boolean, error?: string) => {
        setModelReady(ready)
        setRenderError(error || '')
    }, [])
    const [facing, setFacing] = useState(1)
    const [popupLeft, setPopupLeft] = useState(0)
    const ws = useRef<WebSocket | null>(null)
    const dragArea = useRef<HTMLDivElement>(null)
    const character = useRef<HTMLDivElement>(null)
    const wasDragged = useRef(false)
    const x = useMotionValue(0)
    const y = useMotionValue(0)
    const travel = useMotionValue(0)
    const [reducedMotion, setReducedMotion] = useState(() =>
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    useEffect(() => {
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setReducedMotion(preference.matches)
        preference.addEventListener('change', update)
        update()
        return () => preference.removeEventListener('change', update)
    }, [])

    useEffect(() => {
        let disposed = false
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined
        const connect = () => {
            if (disposed) return
            ws.current = new WebSocket('ws://127.0.0.1:8000/ws')

            ws.current.onopen = () => {
                console.log('Connected to Desktop Companion Assistant backend')
                setIsConnected(true)
                setBubbleText(bilingual('桌面陪伴助手在线', 'Desktop Companion Assistant online'))
            }

            ws.current.onclose = () => {
                window.dispatchEvent(new CustomEvent('aura-perception', { detail: null }))
                setSoundDirection(null)
                setIsConnected(false)
                setBubbleText(bilingual('重新连接中…', 'Reconnecting…'))
                if (!disposed) reconnectTimer = setTimeout(connect, 3000)
            }

            ws.current.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data)

                    if (data.type === "telemetry") {
                        window.dispatchEvent(new CustomEvent('aura-perception', { detail: data }))
                        if (data.perception_error) {
                            const error = systemMessage(data.perception_error)
                            setBubbleText(bilingual(`摄像头/手势识别错误：${displayText(error, 'zh')}`, `Camera/gesture recognition error: ${displayText(error, 'en')}`))
                        }
                        if (data.sound_direction !== undefined) {
                            try {
                                const direction = parseSoundDirection(data.sound_direction)
                                lastSoundTelemetry.current = performance.now()
                                setSoundDirection(direction)
                                setSoundError(systemMessage(direction.error || ''))
                            } catch (error) {
                                console.error('[AURA sound direction]', error)
                                setSoundDirection(null)
                                setSoundError(bilingual('声源定位数据格式错误', 'Sound-direction data format error'))
                            }
                        }
                        if (data.gesture) {
                            window.dispatchEvent(new CustomEvent('aura-gesture', { detail: data.gesture }))
                        }
                        if (typeof data.fps === 'number') {
                            window.dispatchEvent(new CustomEvent('aura-fps', { detail: data.fps }))
                        }
                        if (data.audio) {
                            if (data.audio.is_speaking && typeof data.audio.speech_text === 'string' && data.audio.speech_text) {
                                setBubbleText(data.audio.speech_text)
                            }
                            window.dispatchEvent(new CustomEvent('aura-audio', { detail: data.audio }))
                        }
                    }

                    if (data.type === "response" && data.text) {
                        if (data.system === true && isTtsSynthesisFailure(data.text)) return
                        setBubbleText(data.system === true || data.interrupted === true ? systemMessage(data.text) : data.text)
                    }
                } catch (e) {
                    console.error("Failed to parse websocket message", e)
                }
            }

            ws.current.onerror = (err) => {
                console.error('WebSocket error:', err)
                ws.current?.close()
            }
        }

        const handleResponse = (event: CustomEvent<DisplayText>) => setBubbleText(event.detail)
        window.addEventListener('aura-response', handleResponse as EventListener)
        const soundTimer = setInterval(() => {
            if (lastSoundTelemetry.current && performance.now() - lastSoundTelemetry.current > 750) {
                setSoundDirection(null)
            }
        }, 250)
        connect()

        return () => {
            disposed = true
            clearTimeout(reconnectTimer)
            clearInterval(soundTimer)
            ws.current?.close()
            window.removeEventListener('aura-response', handleResponse as EventListener)
        }
    }, [])

    const handleMouseEnter = () => {
        setIsHovered(true)
        window.electron?.setIgnoreMouseEvents(false)
    }

    const handleMouseLeave = () => {
        setIsHovered(false)
        window.electron?.setIgnoreMouseEvents(true, { forward: true })
    }

    const handleClick = () => {
        if (!wasDragged.current) onListen()
    }

    const isSpeaking = audioState?.is_speaking
    const isListening = audioState?.is_listening
    const level = audioState?.audio_level ?? 0
    const mouthLevel = getSpeechMouthLevel(Boolean(isSpeaking), level)
    const state = isSpeaking ? 'speaking' : isListening ? 'listening' : isThinking ? 'thinking' : 'idle'
    const stateLabel = isSpeaking ? (language === 'en' ? 'Speaking…' : '正在说话…') :
        isListening ? (language === 'en' ? 'Listening to you…' : '在听你说…') :
        isThinking ? (language === 'en' ? 'Thinking…' : '想一想，马上回应…') :
        isWalking ? (language === 'en' ? 'Roaming…' : '散步中…') : (language === 'en' ? 'Idle' : '待机')
    const actionBlocked = Boolean(isSpeaking || isListening || isThinking || isDragging || reducedMotion || !modelReady || renderError)
    const roamingPaused = !vrmCharacter.autoRoaming || actionBlocked


    useLayoutEffect(() => {
        if (!(isHovered || keyboardFocused || isSpeaking || isListening || isThinking) || isDragging) return
        const positionPopup = () => {
            const rect = character.current?.getBoundingClientRect()
            if (!rect) return
            const width = Math.min(256, window.innerWidth - 24)
            const left = Math.max(12, Math.min(rect.right + 16, window.innerWidth - width - 12))
            setPopupLeft(left - rect.left)
        }
        positionPopup()
        const stopX = x.on('change', positionPopup)
        const stopY = y.on('change', positionPopup)
        window.addEventListener('resize', positionPopup)
        return () => {
            stopX()
            stopY()
            window.removeEventListener('resize', positionPopup)
        }
    }, [isHovered, keyboardFocused, isSpeaking, isListening, isThinking, isDragging, x, y])

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let movement: ReturnType<typeof animate> | undefined
        const stop = () => {
            clearTimeout(timer)
            movement?.stop()
            setIsWalking(false)
            travel.set(0)
        }
        const scheduleNext = () => {
            timer = setTimeout(walk, 2000 + Math.random() * 3000)
        }
        const walk = () => {
            const rect = character.current?.getBoundingClientRect()
            if (!rect) return
            const margin = Math.max(16, rect.height * 0.08)
            const minLeft = Math.min(margin, Math.max(0, (window.innerWidth - rect.width) / 2))
            const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - margin)
            const dockTop = document.querySelector('[data-aura-dock]')?.getBoundingClientRect().top
                ?? window.innerHeight - 88
            const minTop = Math.min(margin, Math.max(0, (dockTop - rect.height) / 2))
            const maxTop = Math.max(minTop, dockTop - margin - rect.height)
            const targetTop = minTop + Math.random() * (maxTop - minTop)
            let targetLeft = minLeft + Math.random() * (maxLeft - minLeft)
            if (Math.abs(targetLeft - rect.left) < 60) {
                targetLeft = rect.left < (minLeft + maxLeft) / 2 ? maxLeft : minLeft
            }
            const dx = targetLeft - rect.left
            const dy = targetTop - rect.top
            const distance = Math.hypot(dx, dy)
            if (distance < 1) {
                timer = setTimeout(walk, 3000)
                return
            }
            if (Math.abs(dx) > 1) setFacing(dx < 0 ? -1 : 1)
            const sourceScale = rect.width / vrmCharacter.width
            const startX = x.get()
            const startY = y.get()
            const sourceDistance = distance / sourceScale
            travel.set(0)
            setIsWalking(true)
            movement = animate(0, 1, {
                duration: Math.max(1.2, distance / (vrmCharacter.stride * sourceScale / vrmCharacter.duration)),
                ease: [0.25, 0.1, 0.75, 0.9],
                onUpdate: progress => {
                    x.set(startX + dx * progress)
                    y.set(startY + dy * progress)
                    travel.set(sourceDistance * progress)
                },
                onComplete: () => {
                    setIsWalking(false)
                    travel.set(0)
                    scheduleNext()
                },
            })
        }
        const resize = () => {
            stop()
            const rect = character.current?.getBoundingClientRect()
            const area = dragArea.current?.getBoundingClientRect()
            if (rect && area) {
                const left = Math.max(area.left, Math.min(rect.left, area.right - rect.width))
                const top = Math.max(area.top, Math.min(rect.top, area.bottom - rect.height))
                x.set(x.get() + left - rect.left)
                y.set(y.get() + top - rect.top)
            }
            if (!roamingPaused) timer = setTimeout(walk, 15000)
        }
        if (!roamingPaused) timer = setTimeout(walk, 15000)
        window.addEventListener('resize', resize)
        return () => {
            stop()
            window.removeEventListener('resize', resize)
        }
    }, [roamingPaused, x, y, travel])

    return (
        <div ref={dragArea} className="fixed inset-0 pointer-events-none">
        {renderError && (
            <div data-aura-interactive
                className="fixed top-4 left-4 z-[60] max-w-md max-h-[45vh] overflow-y-auto rounded-xl border border-amber-300/40 bg-black/90 p-3 text-sm text-amber-100 pointer-events-auto">
                <p role="alert">{language === 'en' ? '3D character loading or rendering failed: ' : '3D 人物加载或渲染失败：'}{displayText(systemMessage(renderError), language)}</p>
                <button type="button" aria-label={language === 'en' ? 'Reload character' : '重新加载人物'}
                    className="mt-2 rounded-full border border-amber-300/40 px-3 py-1 text-xs text-amber-200"
                    onClick={() => {
                        setModelReady(false)
                        setRenderError('')
                        setModelGeneration(value => value + 1)
                    }}>
                    {language === 'en' ? 'Reload character' : '重新加载人物'}
                </button>
            </div>
        )}
        <motion.div
            ref={character}
            data-aura-interactive
            data-aura-character
            data-conversation-state={state}
            data-roaming-state={actionBlocked ? 'paused' :
                !vrmCharacter.autoRoaming ? 'disabled' : isWalking ? 'walking' : 'waiting'}
            data-facing={facing}
            data-idle-action="none"
            drag
            dragConstraints={dragArea}
            dragElastic={0}
            dragMomentum={false}
            role="button"
            tabIndex={0}
            aria-label={language === 'en' ?
                isSpeaking || isThinking ? 'Desktop companion: drag to move, click to interrupt dialogue' :
                    isListening ? 'Desktop companion: listening, please speak; drag to move' : 'Desktop companion: drag to move, click to start dialogue' :
                isSpeaking || isThinking ? '动漫桌宠：拖动移动，点击打断对话' :
                    isListening ? '动漫桌宠：正在听，请说话，可拖动移动' : '动漫桌宠：拖动移动，点击开始对话'}
            className="absolute pointer-events-auto cursor-grab active:cursor-grabbing group flex flex-col items-center justify-end touch-none"
            style={{
                x, y,
                width: `min(${97.5 * vrmCharacter.width / vrmCharacter.height}vh, calc((100vh - 144px) * ${vrmCharacter.width / vrmCharacter.height}), 72vw)`,
                left: `calc(50% - min(${48.75 * vrmCharacter.width / vrmCharacter.height}vh, calc((100vh - 144px) * ${vrmCharacter.width / vrmCharacter.height / 2}), 36vw))`,
                top: `max(12px, calc(50% - min(48.75vh, calc((100vh - 144px) / 2), ${36 * vrmCharacter.height / vrmCharacter.width}vw) - 13px))`,
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerDown={() => {
                wasDragged.current = false
            }}
            onDragStart={() => {
                wasDragged.current = true
                setIsDragging(true)
            }}
            onDragEnd={() => setIsDragging(false)}
            onFocus={(event) => {
                if (event.currentTarget.matches(':focus-visible')) setKeyboardFocused(true)
            }}
            onBlur={() => setKeyboardFocused(false)}
            onTap={handleClick}
            onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault()
                    onListen()
                }
            }}
        >
            {!isDragging && (isHovered || keyboardFocused || isSpeaking || isListening || isThinking) && (
                <motion.div
                    data-aura-visible
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ left: popupLeft }}
                    className="absolute top-4 w-64 max-w-[calc(100vw-24px)] max-h-48 overflow-y-auto bg-black/80 text-white px-4 py-3 rounded-2xl border border-white/20 whitespace-pre-wrap font-sans"
                >
                    <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-cyan-300 mb-0.5">
                        {isSpeaking ? <Volume2 size={14} className="animate-pulse text-amber-300" /> : null}
                        <span>{stateLabel}</span>
                    </div>
                    <div className="text-sm font-medium leading-snug">
                        {isListening ? (language === 'en' ? "Take your time, I'm listening." : '慢慢说，我在听。') :
                            isThinking ? (language === 'en' ? 'Thinking about what you said. One moment.' : '正在整理你的话，稍等一下。') :
                                displayText(bubbleText, language)}
                    </div>
                </motion.div>
            )}

                <div
                    data-aura-body
                    className="relative w-full origin-bottom pointer-events-none"
                    style={{ aspectRatio: `${vrmCharacter.width}/${vrmCharacter.height}` }}
                >
                    <div
                        data-aura-speech-motion
                        className="absolute inset-0 origin-bottom"
                    >
                        <VrmCharacter key={modelGeneration} language={language} walking={isWalking && !reducedMotion} facing={facing}
                            studioBackground={studioBackground}
                            position={{ x, y }}
                            dialogueState={state}
                            soundYaw={soundYawRadians(soundDirection)}
                            distance={travel} mouthLevel={mouthLevel}
                            mouthViseme={audioState?.lip_sync_mode === 'word-timestamps' ?
                                audioState.viseme ?? null : 'aa'}
                            mouthWeights={audioState?.lip_sync_mode === 'word-timestamps' ?
                                audioState.mouth_weights : null}
                            closeup={dialogueCloseup && Boolean(isSpeaking || isListening || isThinking)}
                            reducedMotion={Boolean(reducedMotion)} onStatus={handleModelStatus} />
                    </div>
                </div>
            <div className="relative flex items-center gap-1.5 rounded-full border border-white/20 bg-black/75 px-3 py-1 text-[11px] text-cyan-200">
                {isConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
                <span>
                    {renderError ? (language === 'en' ? '3D character unavailable. Reload using the error panel.' : '3D 人物不可用，请在错误提示中重新加载。') :
                        !modelReady ? (language === 'en' ? 'Loading real-time 3D…' : '正在加载实时 3D…') :
                            isConnected ? stateLabel : (language === 'en' ? 'Connecting…' : '连接中…')}
                </span>
            </div>
            {soundDirection?.enabled && !soundError && (
                <span data-aura-sound-status className="text-[11px] text-cyan-200">
                    {!soundDirection.ready ? (language === 'en' ? 'Starting microphone array…' : '阵列启动中…') :
                        soundDirection.suppressed ? (language === 'en' ? 'Sound direction: holding during playback' : '声源定位：播放期间保持') :
                            soundDirection.tracking ? (language === 'en' ? 'Sound direction: tracking' : '声源定位：跟随中') :
                                (language === 'en' ? 'Sound direction: waiting for speech' : '声源定位：等待人声')}
                </span>
            )}
            {soundError && <span role="alert" className="text-[11px] text-red-300">
                {language === 'en' ? 'Sound direction: ' : '声源定位：'}{displayText(soundError, language)}
            </span>}
        </motion.div>
        </div>
    )
}

export default Bubble
