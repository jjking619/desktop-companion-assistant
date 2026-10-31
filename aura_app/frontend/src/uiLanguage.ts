export type Language = 'zh' | 'en'
export type DisplayText = string | Record<Language, string>

export function bilingual(zh: string, en: string): Record<Language, string> {
    return { zh, en }
}

export function displayText(text: DisplayText, language: Language): string {
    return typeof text === 'string' ? text : text[language]
}
