import { bilingual } from './uiLanguage.ts'
import type { DisplayText } from './uiLanguage.ts'

const messages: Record<string, string> = {
    '阵列音频必须为不超过 12 秒的单通道 16 kHz / 16 bit PCM。': 'Array audio must be mono 16 kHz / 16-bit PCM, no longer than 12 seconds.',
    '阵列音频输入格式无效。': 'Invalid microphone array audio input format.',
    '阵列语音识别会话异常结束。': 'The array speech recognition session ended unexpectedly.',
    '麦克风处理短暂积压，本句录音已取消，请重新说话。': 'Microphone processing fell behind. This recording was cancelled; please speak again.',
    '麦克风阵列尚未就绪，请稍后重试。': 'The microphone array is not ready. Please retry shortly.',
    '麦克风没有返回音频，请检查系统输入设备及 AURA_MIC_DEVICE。': 'No audio received from the microphone. Check the system input device and AURA_MIC_DEVICE.',
    '无法录制麦克风，请检查 AURA_MIC_DEVICE 和录音设备占用。': 'Cannot record from the microphone. Check AURA_MIC_DEVICE and whether another application is using it.',
    '百炼语音识别请求失败，请检查 API Key、余额、ASR 模型及服务地址。': 'Bailian speech recognition failed. Check the API key, balance, ASR model and endpoint.',
    '百炼录音/识别超时，请检查麦克风和网络后重试。': 'Bailian recording/recognition timed out. Check the microphone and network, then retry.',
    '百炼录音/识别失败，请检查麦克风、Key、ASR 模型及网络。': 'Bailian recording/recognition failed. Check the microphone, API key, ASR model and network.',
    '百炼识别进程返回了无效结果。': 'The Bailian recognition process returned an invalid result.',
    'AURA_PROVIDER 必须为 local 或 bailian。': 'AURA_PROVIDER must be local or bailian.',
    '未配置 DASHSCOPE_API_KEY，请在仓库根目录 .env 或 ~/.config/aura/bailian.env 中设置北京百炼 API Key，并重启桌面陪伴助手。': 'DASHSCOPE_API_KEY is missing. Configure a Beijing Bailian API key in the root .env or ~/.config/aura/bailian.env, then restart Desktop Companion Assistant.',
    'AURA_ASR_LANGUAGES 仅支持 paraformer-realtime-v2，请检查 ASR 模型配置。': 'AURA_ASR_LANGUAGES is supported only by paraformer-realtime-v2. Check the ASR model configuration.',
    'AURA_ASR_LANGUAGES 必须为逗号分隔的语种代码：en,zh,ja,ko,de,fr,ru。': 'AURA_ASR_LANGUAGES must contain comma-separated language codes: en,zh,ja,ko,de,fr,ru.',
    '百炼返回了无效的口型时间戳事件。': 'Bailian returned an invalid lip-sync timestamp event.',
    '带时间戳的语音合成超时，未开始播放。': 'Timestamped speech synthesis timed out. Playback has not started.',
    '百炼未返回有效的 16bit PCM 音频，无法播放或驱动嘴型。': 'Bailian returned no valid 16-bit PCM audio for playback or lip sync.',
    '百炼带时间戳的语音合成失败，请检查音色支持及服务配置。': 'Timestamped Bailian speech synthesis failed. Check voice support and service configuration.',
    '流式回复包含无效文字，已停止语音播放。': 'The streamed reply contained invalid text. Speech playback was stopped.',
    '语音合成返回了无效的 PCM 音频，无法调整停顿。': 'Speech synthesis returned invalid PCM audio; silence trimming is unavailable.',
    '语音合成返回了全静音音频，未开始播放。': 'Speech synthesis returned silent audio. Playback has not started.',
    '语音 PCM 播放器在音频发送完成前退出。': 'The speech PCM player exited before all audio was sent.',
    '语音 PCM 播放写入超时，请检查输出设备。': 'Speech PCM playback writes timed out. Check the output device.',
    '板载扬声器需要 16bit 单声道或双声道 PCM 音频。': 'The onboard speaker requires 16-bit mono or stereo PCM audio.',
    '语音播放缺少 espeak-ng 或音频播放工具，请检查 README.md。': 'Speech playback requires espeak-ng and an audio player. See README.md.',
    '语音合成返回了不支持的音频格式。': 'Speech synthesis returned an unsupported audio format.',
    '缺少音频播放工具，请检查 README.md。': 'The audio playback tool is missing. See README.md.',
    '音频播放超时，请检查音频输出设备。': 'Audio playback timed out. Check the audio output device.',
    '无法初始化语音引擎。': 'Cannot initialize the speech engine.',
    '人物播放期间不能录音。': 'Recording is unavailable during speech playback.',
    '人物正在说话，请播放结束后再点击录音，避免扬声器回声。': 'The character is speaking. Wait until playback finishes before recording to avoid speaker echo.',
    '连续对话第一版需要启用麦克风阵列声源服务并配置百炼语音。': 'Continuous dialogue requires the microphone array sound service and Bailian speech configuration.',
    '连续对话第一版需要 AURA_PROVIDER=bailian 和 AURA_SOUND_LOCALIZATION=1；单次说话仍可使用。': 'Continuous dialogue requires AURA_PROVIDER=bailian and AURA_SOUND_LOCALIZATION=1; single-turn speech remains available.',
    '请先取消语音静音，再开始连续对话。': 'Unmute speech before starting continuous dialogue.',
    '未识别出有效文字，已结束连续对话；请重试。': 'No valid text was recognized. Continuous dialogue has ended; please retry.',
    '当前语音已静音，已结束连续对话。': 'Speech is muted. Continuous dialogue has ended.',
    '处理请求失败，请检查后端日志。': 'Request processing failed. Check the backend logs.',
    '已结束连续对话，可重新点击说话。': 'Continuous dialogue has ended. You can start again.',
    '已结束连续对话，可重新开始。': 'Continuous dialogue has ended. You can start again.',
    '已打断，可重新点击说话。': 'Dialogue interrupted. You can start again.',
    '正在处理对话，请先打断或等待本轮结束。': 'A dialogue is in progress. Stop it or wait for this turn to finish.',
    '正在处理语音对话，请等待当前一轮结束。': 'A voice dialogue is in progress. Wait for the current turn to finish.',
    '30 秒未检测到有效语音，已结束连续对话。': 'No valid speech detected for 30 seconds. Continuous dialogue has ended.',
    '语音识别尚未安装：缺少 PyAudio 和 PortAudio。请安装语音依赖或配置百炼语音。': 'Speech recognition dependencies PyAudio and PortAudio are missing. Install them or configure Bailian speech.',
    '当前已静音，请先取消静音。': 'Speech is muted. Please unmute first.',
    '测试语音播放完成，请确认扬声器声音。': 'Speech test completed. Please check the speaker output.',
    '已静音。': 'Muted.',
    '已取消静音。': 'Unmuted.',
    '百炼客户端未初始化，更新配置后请重启桌面陪伴助手。': 'The Bailian client is not initialized. Update the configuration and restart Desktop Companion Assistant.',
    '模型返回了无效的流式文字，请重试。': 'The model returned invalid streamed text. Please retry.',
    '模型返回了空回复，请重试。': 'The model returned an empty reply. Please retry.',
    '模型回复流意外中断，请重试。': 'The model reply stream ended unexpectedly. Please retry.',
    '缺少英文口型词典 cmudict，请更新 Linux 后端依赖。': 'The English lip-sync dictionary cmudict is missing. Update the Linux backend dependencies.',
    '语音服务没有返回字级时间戳。': 'The speech service returned no word timestamps.',
    '语音服务返回了无效的字级时间戳。': 'The speech service returned invalid word timestamps.',
    '当前音色未返回可用的字级口型时间轴，请检查音色是否支持时间戳。': 'The current voice returned no usable word-level lip-sync timeline. Check timestamp support.',
    '字级时间戳重叠或时间轴重置，无法准确驱动口型。': 'Word timestamps overlap or the timeline reset; accurate lip sync is unavailable.',
    'WebGL 图形上下文已丢失，请重新加载人物；若反复发生，请用 AURA_SOFTWARE_RENDERING=1 重启桌面陪伴助手。': 'The WebGL graphics context was lost. Reload the character; if this persists, restart Desktop Companion Assistant with AURA_SOFTWARE_RENDERING=1.',
    '全局 3D 场景容器不存在，请重新加载人物。': 'The global 3D scene container is missing. Reload the character.',
    'GPU 模式实际回退到了软件渲染，请检查显卡驱动；可用 AURA_SOFTWARE_RENDERING=1 恢复安全模式。': 'GPU mode fell back to software rendering. Check the graphics driver or restart with AURA_SOFTWARE_RENDERING=1.',
}

const patterns: Array<[RegExp, (...values: string[]) => string]> = [
    [/^无法打开麦克风 (.+)，请检查设备是否已拔出、被占用或没有录音权限。$/,
        device => `Cannot open microphone ${device}. Check its connection, recording permissions and whether another application is using it.`],
    [/^模型回复未完整结束（(.+)），请重试。$/,
        reason => `The model reply did not complete (${reason}). Please retry.`],
    [/^(百炼|OpenAI)流式对话请求失败（(.+)），请检查网络、Key、模型及余额。$/,
        (provider, error) => `${provider === '百炼' ? 'Bailian' : provider} streaming dialogue failed (${error}). Check the network, API key, model and balance.`],
    [/^百炼对话请求失败（(.+)），请检查 Key、模型、余额及服务区域。$/,
        error => `Bailian dialogue failed (${error}). Check the API key, model, balance and service region.`],
    [/^百炼语音合成失败（(.+)），请检查 Key、余额、模型\/音色及北京服务地址。$/,
        error => `Bailian speech synthesis failed (${error}). Check the API key, balance, model/voice and Beijing endpoint.`],
    [/^音频播放失败：([\s\S]*)$/, detail => `Audio playback failed: ${detail}`],
]

export function isTtsSynthesisFailure(text: string): boolean {
    return /TTS synthesis failed:/i.test(text) || text.includes('百炼语音合成失败（')
}

// Only use for diagnostics and explicitly marked system responses, never chat replies.
export function systemMessage(text: string): DisplayText {
    if (text === '阵列音频未返回识别文字，请重试。' ||
        /^阵列音频未返回识别文字(?:（.*?）|：.*|。.*)?(?:；.*)?$/.test(text) ||
        /^阵列音频未返回识别文字（[\d.]+ 秒 PCM，ASR=[^）]+）(?:；.*)?$/.test(text)) {
        return bilingual('未识别到文字，请重试。', 'No text recognized. Please retry.')
    }
    const translated = messages[text]
    if (translated) return bilingual(text, translated)
    for (const [pattern, format] of patterns) {
        const match = pattern.exec(text)
        if (match) return bilingual(text, format(...match.slice(1)))
    }
    return text
}
