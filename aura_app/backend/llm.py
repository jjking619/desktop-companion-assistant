import os
from collections.abc import Iterator
from openai import OpenAI, OpenAIError
from bailian import SpeechError, cloud_enabled, require_key

class LLMEngine:
    def __init__(self):
        self.is_bailian = cloud_enabled()
        self.api_key = os.getenv("DASHSCOPE_API_KEY" if self.is_bailian else "OPENAI_API_KEY")
        self.client = None
        
        if self.api_key:
            self.client = OpenAI(
                api_key=self.api_key,
                base_url=os.getenv("AURA_LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
                if self.is_bailian else None,
                timeout=25, max_retries=0,
            )
        elif self.is_bailian:
            print("[LLM] 百炼模式尚未配置 DASHSCOPE_API_KEY，不会退回模拟回答。")
        else:
            print("Warning: OPENAI_API_KEY not found. Using mock responses.")

    def _messages(self, prompt, history):
        system_prompt = (
            "You are Desktop Companion Assistant, the user's desktop companion. Speak in natural, conversational English by default, "
            "even when the user speaks another language; use Chinese or another language when the user asks "
            "for it or clearly requests that language. Be warm, relaxed, and responsive, like a friend talking "
            "face to face; avoid a customer-service, announcer, or sci-fi robot tone. Respond directly without "
            "repeatedly introducing yourself. Keep replies concise, usually one or two complete spoken sentences "
            "suitable for text-to-speech. Do not use Markdown, emojis, or parenthetical stage directions."
        )
        return [
            {"role": "system", "content": system_prompt},
            *(history or [])[-5:],
            {"role": "user", "content": prompt},
        ]

    def _model(self):
        return os.getenv("AURA_LLM_MODEL", "qwen-plus") if self.is_bailian else "gpt-4o-mini"

    def _mock_response(self, prompt):
        if self.is_bailian:
            require_key()
            raise SpeechError("百炼客户端未初始化，更新配置后请重启桌面陪伴助手。")
        return f"I heard '{prompt}', but the conversation service is not configured because the API key is missing."

    def stream_response(self, prompt: str, history: list | None = None) -> Iterator[str]:
        if not self.client:
            yield self._mock_response(prompt)
            return
        try:
            stream = self.client.chat.completions.create(
                model=self._model(), messages=self._messages(prompt, history),
                max_tokens=192, stream=True,
            )
            has_content = False
            finished = False
            try:
                for chunk in stream:
                    if not chunk.choices:
                        continue
                    choice = chunk.choices[0]
                    text = choice.delta.content
                    if text is not None:
                        if not isinstance(text, str):
                            raise SpeechError("模型返回了无效的流式文字，请重试。")
                        has_content = has_content or bool(text.strip())
                        if text:
                            yield text
                    if choice.finish_reason is not None:
                        if choice.finish_reason != "stop":
                            raise SpeechError(f"模型回复未完整结束（{choice.finish_reason}），请重试。")
                        finished = True
                        break
                if not has_content:
                    raise SpeechError("模型返回了空回复，请重试。")
                if not finished:
                    raise SpeechError("模型回复流意外中断，请重试。")
            finally:
                stream.close()
        except OpenAIError as error:
            provider = "百炼" if self.is_bailian else "OpenAI"
            raise SpeechError(
                f"{provider}流式对话请求失败（{type(error).__name__}），请检查网络、Key、模型及余额。"
            ) from error

    def generate_response(self, prompt: str, history: list | None = None) -> str:
        if not self.client:
            return self._mock_response(prompt)

        try:
            response = self.client.chat.completions.create(
                model=self._model(), messages=self._messages(prompt, history),
                max_tokens=192,
            )
            
            text = response.choices[0].message.content if response.choices else None
            if not text or not text.strip():
                raise SpeechError("模型返回了空回复，请重试。")
            return text
        except OpenAIError as e:
            if self.is_bailian:
                raise SpeechError(f"百炼对话请求失败（{type(e).__name__}），请检查 Key、模型、余额及服务区域。") from e
            print(f"LLM Error: {e}")
            return "I'm having trouble thinking right now."
