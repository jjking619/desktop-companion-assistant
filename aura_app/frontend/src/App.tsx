import { useState, useEffect, useRef } from 'react'
import Bubble from './components/Bubble'
import CameraPreviewHUD from './components/CameraPreviewHUD'
import StudioBackground from './components/StudioBackground'
import type { SpeechAudioState } from './components/speechPresentation'
import { getDialogueState } from './components/speechPresentation'
import { studioPreferenceKey } from './components/vrmPresentation'
import { bilingual, displayText } from './uiLanguage'
import type { DisplayText, Language } from './uiLanguage'
import { isTtsSynthesisFailure, systemMessage } from './systemMessages'

const uiText = {
  zh: {
    close: '关闭',
    gestureOn: '手势：开启',
    gestureOff: '手势：关闭',
    gesturePreviewTit: '开启手势识别和摄像头预览',
    gesturePreviewClose: '关闭手势识别和摄像头预览，释放资源',
    continuousStart: '开始对话',
    continuousStop: '结束连续对话',
    continuousStarting: '正在开启连续对话…',
    continuousEnding: '正在结束…',
    interrupt: '打断',
    interrupting: '正在打断…',
    volume: '语音音量',
    closeupOn: '对话近景：开',
    closeupOff: '对话近景：关',
    sceneStudio: '背景：全局场景',
    sceneTransparent: '背景：透明',
    language: '中 / EN',
    languageTitle: '切换中英文显示',
    statusClose: '关闭',
  },
  en: {
    close: 'Close',
    gestureOn: 'Gesture: On',
    gestureOff: 'Gesture: Off',
    gesturePreviewTit: 'Enable gesture recognition and camera preview',
    gesturePreviewClose: 'Disable gesture recognition and camera preview, release resources',
    continuousStart: 'Start dialogue',
    continuousStop: 'Stop dialogue',
    continuousStarting: 'Starting continuous dialogue…',
    continuousEnding: 'Stopping…',
    interrupt: 'Interrupt',
    interrupting: 'Interrupting…',
    volume: 'Volume',
    closeupOn: 'Close-up: On',
    closeupOff: 'Close-up: Off',
    sceneStudio: 'Background: Studio',
    sceneTransparent: 'Background: Transparent',
    language: 'EN / 中',
    languageTitle: 'Switch to Chinese display',
    statusClose: 'Close',
  },
} as const

function readStudioPreference(): { enabled: boolean, error: DisplayText } {
  try {
    const saved = localStorage.getItem(studioPreferenceKey)
    if (saved === null || saved === 'studio') return { enabled: true, error: '' }
    if (saved === 'transparent') return { enabled: false, error: '' }
    console.error('[AURA] Invalid saved studio preference:', saved)
    return { enabled: true, error: bilingual('保存的背景设置无效，已暂用摄影棚，请重新选择背景。', 'Invalid saved background setting. Using the studio; please select a background again.') }
  } catch (error) {
    console.error('[AURA] Reading studio preference failed:', error)
    return { enabled: true, error: bilingual('无法读取背景设置，已暂用摄影棚；本次仍可切换背景。', 'Cannot read background settings. Using the studio; you can still switch backgrounds.') }
  }
}

function App() {
  const [language, setLanguage] = useState<Language>('zh')
  const t = uiText[language]
  const [gesturePreviewOpen, setGesturePreviewOpen] = useState(false)
  const [studioPreference] = useState(readStudioPreference)
  const [studioBackground, setStudioBackground] = useState(studioPreference.enabled)
  const [studioError, setStudioError] = useState(studioPreference.error)
  const [audioState, setAudioState] = useState<SpeechAudioState>({ is_speaking: false, is_listening: false, audio_level: 0.0 })
  const [commandStatus, setCommandStatus] = useState<DisplayText>('')
  const [dialogueCloseup, setDialogueCloseup] = useState(true)
  const [pendingCommand, setPendingCommand] = useState<string | null>(null)
  const commandPending = pendingCommand !== null
  const continuous = pendingCommand === 'START_CONTINUOUS' || Boolean(audioState.conversation_active)
  const dialogueState = getDialogueState(audioState, commandPending)
  const [isStopping, setIsStopping] = useState(false)
  const canInterrupt = dialogueState !== 'listening' && (commandPending || dialogueState !== 'idle')
  const commandSocket = useRef<WebSocket | null>(null)
  const commandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopRequested = useRef(false)
  const finishCommand = useRef<((message: DisplayText) => void) | null>(null)

  useEffect(() => () => {
    if (commandTimer.current) clearTimeout(commandTimer.current)
    commandSocket.current?.close()
  }, [])

  const sendCommand = (command: string) => {
    if (commandSocket.current) return
    stopRequested.current = command === 'STOP_SPEECH' || command === 'STOP_CONTINUOUS'
    setIsStopping(stopRequested.current)
    setPendingCommand(command)
    const localStatus = stopRequested.current ? bilingual('正在结束…', 'Stopping…') :
      command === 'START_CONTINUOUS' ? bilingual('正在开启连续对话…', 'Starting continuous dialogue…') :
      command === "LISTEN_COMMAND" ? bilingual('正在连接语音服务…', 'Connecting voice service…') :
      bilingual('正在处理…', 'Processing…')
    setCommandStatus(localStatus)
    const socket = new WebSocket('ws://127.0.0.1:8000/ws')
    commandSocket.current = socket
    let completed = false
    const finish = (message: DisplayText) => {
      if (completed) return
      completed = true
      if (commandTimer.current) clearTimeout(commandTimer.current)
      commandTimer.current = null
      commandSocket.current = null
      finishCommand.current = null
      setPendingCommand(null)
      setIsStopping(false)
      setCommandStatus(message)
      if (command === 'START_CONTINUOUS' || command === 'STOP_CONTINUOUS') {
        setAudioState(previous => ({
          ...previous, conversation_active: false, conversation_phase: 'idle',
          dialogue_state: 'idle', is_listening: false, is_speaking: false, is_preparing: false,
          audio_level: 0, speech_text: '', viseme: null, mouth_weights: null,
        }))
      }
      socket.close()
    }
    finishCommand.current = finish
    commandTimer.current = setTimeout(() => finish(bilingual("请求超时，请检查后端日志。", 'Request timed out. Check the backend logs.')),
      command === 'START_CONTINUOUS' ? 15000 : command === "LISTEN_COMMAND" ? 150000 : 45000)
    socket.onopen = () => {
      if (completed) return
      const stopCommand = command === 'START_CONTINUOUS' || command === 'STOP_CONTINUOUS' ?
        'STOP_CONTINUOUS' : 'STOP_SPEECH'
      socket.send(stopRequested.current ? stopCommand : command)
    }
    socket.onmessage = (event) => {
      if (completed) return
      try {
        const data = JSON.parse(event.data)
        if (command === 'START_CONTINUOUS' && !stopRequested.current) {
          if (commandTimer.current) clearTimeout(commandTimer.current)
          commandTimer.current = setTimeout(() => finish(bilingual('连续对话连接超时，已断开，请重试。', 'Continuous dialogue connection timed out. Disconnected; please retry.')), 15000)
        }
        if (data.type === 'conversation_turn' && typeof data.text === 'string' && !stopRequested.current) {
          window.dispatchEvent(new CustomEvent('aura-response', { detail: data.text }))
          setCommandStatus(data.text)
        }
        if (data.type === "response" && typeof data.text === "string") {
          if (stopRequested.current && !data.interrupted) return
          if (data.system === true && isTtsSynthesisFailure(data.text)) {
            finish('')
            return
          }
          if (data.interrupted) {
            setAudioState(previous => ({
              ...previous, is_speaking: false, is_listening: false, is_preparing: false,
              dialogue_state: 'idle', audio_level: 0, speech_text: '', viseme: null, mouth_weights: null,
            }))
          }
          const text = data.system === true || data.interrupted === true ? systemMessage(data.text) : data.text
          window.dispatchEvent(new CustomEvent('aura-response', { detail: text }))
          finish(text)
        }
      } catch (error) {
        console.error("Invalid command response", error)
        finish(bilingual("后端响应格式错误，请检查日志。", 'Invalid backend response. Check the logs.'))
      }
    }
    socket.onerror = () => finish(bilingual("无法连接桌面陪伴助手后端（127.0.0.1:8000）。", 'Cannot connect to the Desktop Companion Assistant backend (127.0.0.1:8000).'))
    socket.onclose = () => finish(bilingual("连接已断开，请重试。", 'Connection lost. Please retry.'))
  }

  const stopSpeech = () => {
    const socket = commandSocket.current
    if (!socket) {
      sendCommand(continuous ? 'STOP_CONTINUOUS' : 'STOP_SPEECH')
      return
    }
    if (stopRequested.current) return
    stopRequested.current = true
    setIsStopping(true)
    setCommandStatus(continuous ? bilingual('正在结束连续对话…', 'Stopping continuous dialogue…') : bilingual('正在打断…', 'Interrupting…'))
    if (socket.readyState === WebSocket.OPEN) socket.send(continuous ? 'STOP_CONTINUOUS' : 'STOP_SPEECH')
    if (commandTimer.current) clearTimeout(commandTimer.current)
    commandTimer.current = setTimeout(() => finishCommand.current?.(bilingual('打断请求超时，请检查后端连接。', 'Stop request timed out. Check the backend connection.')), 10000)
  }

  useEffect(() => {
    const handleAudio = (e: CustomEvent<SpeechAudioState>) => {
      setAudioState(e.detail)
      if (!stopRequested.current && commandSocket.current) {
        if (e.detail.conversation_phase === 'waiting') setCommandStatus(bilingual("连续对话：等你说话，30 秒无有效语音后自动退出。", 'Continuous dialogue: waiting for you, auto-exit after 30s with no valid speech.'))
        else if (e.detail.conversation_phase === 'recognizing') setCommandStatus(bilingual("连续对话：正在识别…", 'Continuous dialogue: recognizing…'))
        else if (e.detail.conversation_phase === 'cooldown') setCommandStatus(bilingual("连续对话：即将继续听…", 'Continuous dialogue: listening again soon…'))
        else if (e.detail.is_listening) setCommandStatus(bilingual("正在听，请说话…", 'Listening, please speak…'))
        else if (e.detail.is_speaking && e.detail.speech_text) setCommandStatus(e.detail.speech_text)
        else if (e.detail.dialogue_state === 'thinking') setCommandStatus(bilingual("想一想，马上回应…", 'Thinking…'))
      }
      if (e.detail.error) {
        if (isTtsSynthesisFailure(e.detail.error)) {
          setCommandStatus('')
          return
        }
        const error = systemMessage(e.detail.error)
        setCommandStatus(bilingual(`语音播放错误：${displayText(error, 'zh')}`, `Audio playback error: ${displayText(error, 'en')}`))
      }
    }

    window.addEventListener('aura-audio', handleAudio as EventListener)

    return () => {
      window.removeEventListener('aura-audio', handleAudio as EventListener)
    }
  }, [])



  return (
    <div className="w-screen h-screen bg-transparent overflow-hidden relative select-none">
      {studioBackground && <StudioBackground />}
      {commandStatus && (
        <div
          data-aura-interactive
          role="status"
          className="fixed pointer-events-auto bottom-32 left-1/2 -translate-x-1/2 max-w-lg max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-xl bg-black/80 px-4 py-3 text-sm text-white border border-cyan-500/30 z-50"
        >
          {displayText(commandStatus, language)}
          {!commandPending && (
            <button className="ml-3 text-cyan-300" onClick={() => setCommandStatus("")}>{t.close}</button>
          )}
        </div>
      )}
      {studioError && (
        <div data-aura-interactive role="alert"
          className="fixed pointer-events-auto top-4 right-4 max-w-sm rounded-xl bg-black/90 px-4 py-3 text-sm text-amber-200 z-50">
          {displayText(studioError, language)}
          <button type="button" className="ml-3 text-cyan-300" onClick={() => setStudioError('')}>{t.close}</button>
        </div>
      )}
      <div data-aura-interactive data-aura-dock
        className="fixed pointer-events-auto bottom-6 left-1/2 -translate-x-1/2 flex flex-wrap items-center justify-center w-max max-w-[calc(100vw-24px)] rounded-2xl bg-black/75 border border-white/20 px-3 py-2 text-cyan-200 z-40">
        <button type="button" aria-label={language === 'en' ? 'Switch language' : '切换语言'}
          title={language === 'en' ? 'Switch to Chinese display' : '切换到英文显示'}
          className="shrink-0 whitespace-nowrap px-2 py-1 text-xs border-r border-white/20"
          onClick={() => setLanguage(value => value === 'zh' ? 'en' : 'zh')}>
          {t.language}
        </button>
        <button type="button" aria-label={language === 'en' ? 'Gesture preview' : '手势预览'} aria-pressed={gesturePreviewOpen}
          title={gesturePreviewOpen ? (language === 'en' ? 'Disable gesture recognition and camera preview, release resources' : '关闭手势识别和摄像头预览，释放资源') : (language === 'en' ? 'Enable gesture recognition and camera preview' : '开启手势识别和摄像头预览')}
          className="shrink-0 whitespace-nowrap px-3 py-1 text-sm"
          onClick={() => setGesturePreviewOpen(value => !value)}>
          {gesturePreviewOpen ? t.gestureOn : t.gestureOff}
        </button>
        <button type="button" aria-label={continuous ? (language === 'en' ? 'Stop continuous dialogue' : '结束连续对话') : (language === 'en' ? 'Start dialogue' : '开始对话')}
          aria-pressed={continuous}
          disabled={isStopping || (!continuous && (commandPending || dialogueState !== 'idle'))}
          title={language === 'en' ? 'Listen automatically after each reply; exit after 30 seconds without valid speech.' : '回答后自动继续听，30 秒无有效语音退出；人物说话时不录音'}
          className="shrink-0 whitespace-nowrap px-3 py-1 text-sm disabled:opacity-50"
          onClick={() => continuous ? stopSpeech() : sendCommand('START_CONTINUOUS')}>
          {isStopping && continuous ? t.continuousEnding : continuous ? t.continuousStop : t.continuousStart}
        </button>
        {canInterrupt && !continuous && (
          <button type="button" aria-label={language === 'en' ? 'Interrupt dialogue' : '打断对话'} disabled={isStopping}
            className="shrink-0 whitespace-nowrap px-3 py-1 text-amber-200 disabled:opacity-50"
            onClick={stopSpeech}>
            {isStopping ? t.interrupting : t.interrupt}
          </button>
        )}
        {audioState.gesture_volume_enabled && (
          <span role="status" title={language === 'en' ? 'Adjust only the assistant voice; swipe up +5%, swipe down -5%' : '仅调节助手自身语音；上滑 +5%，下滑 -5%'}
            className="shrink-0 whitespace-nowrap px-2 text-sm text-cyan-200">
            {t.volume} {audioState.volume_percent ?? 100}%
          </span>
        )}
        <button type="button" aria-pressed={dialogueCloseup} title={language === 'en' ? 'Zoom in on the character during dialogue' : '对话时放大人物'}
          className="shrink-0 whitespace-nowrap px-3 py-1 border-l border-white/20 text-sm"
          onClick={() => setDialogueCloseup(value => !value)}>
          {dialogueCloseup ? t.closeupOn : t.closeupOff}
        </button>
        <button type="button" aria-label={language === 'en' ? 'Studio background' : '摄影棚背景'} aria-pressed={studioBackground}
          title={language === 'en' ? 'Switch global scene and transparent desk pet, saved automatically; Linux scene mode covers the desktop, switch back to transparent when you need to operate the desktop.' : '切换全局场景与透明桌宠，自动保存选择；Linux 场景模式覆盖桌面，需操作桌面时切回透明'}
          className="shrink-0 whitespace-nowrap px-3 py-1 border-l border-white/20 text-sm"
          onClick={() => {
            const enabled = !studioBackground
            setStudioBackground(enabled)
            try {
              localStorage.setItem(studioPreferenceKey, enabled ? 'studio' : 'transparent')
              setStudioError('')
            } catch (error) {
              console.error('[AURA] Saving studio preference failed:', error)
              setStudioError(bilingual('背景已更改，但保存失败；下次启动可能需要重新选择。', 'Background changed, but saving failed; you may need to reselect it next launch.'))
            }
          }}>
          {studioBackground ? t.sceneStudio : t.sceneTransparent}
        </button>
      </div>
      {gesturePreviewOpen && <CameraPreviewHUD language={language} isOpen onClose={() => setGesturePreviewOpen(false)} />}
      <Bubble language={language} audioState={audioState} dialogueCloseup={dialogueCloseup} studioBackground={studioBackground}
        isThinking={dialogueState === 'thinking'}
        onListen={() => {
          if (canInterrupt && !isStopping) stopSpeech()
          else if (!commandPending && dialogueState === 'idle') sendCommand('START_CONTINUOUS')
        }} />
    </div>
  )
}

export default App
