import os
import time
import logging
from typing import List, Optional, Dict, Any, Union, Iterator
from enum import Enum


class LLMProvider(str, Enum):
    OPENAI = "openai"
    MINIMAX = "minimax"
    DEEPSEEK = "deepseek"


class LLMConfig:
    def __init__(
        self,
        provider: LLMProvider = LLMProvider.OPENAI,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = "gpt-4-turbo-preview",
        embedding_model: str = "text-embedding-3-small",
        embedding_dimension: int = 1536,
        chat_max_tokens: Optional[int] = None,
        chat_temperature: Optional[float] = None,
        context_window_tokens: Optional[int] = None,
    ):
        self.provider = provider
        default_key = os.getenv("OPENAI_API_KEY")
        if provider == LLMProvider.MINIMAX:
            default_key = os.getenv("MINIMAX_API_KEY") or default_key
        elif provider == LLMProvider.DEEPSEEK:
            default_key = os.getenv("DEEPSEEK_API_KEY") or default_key
        self.api_key = default_key if api_key is None else api_key
        self.model = model
        self.embedding_model = embedding_model
        self.embedding_dimension = embedding_dimension
        default_chat_max_tokens = _safe_positive_int(os.getenv("LLM_MAX_TOKENS"), 4000)
        default_chat_temperature = _safe_temperature(os.getenv("LLM_TEMPERATURE"), 0.7)
        default_context_window_tokens = _safe_positive_int(
            os.getenv("LLM_CONTEXT_WINDOW_TOKENS"),
            32768,
        )

        if provider == LLMProvider.MINIMAX:
            self.base_url = base_url or "https://api.minimaxi.com/v1"
            self.model = model or "MiniMax-M2.5"
            self.embedding_model = "embo-01"
            self.embedding_dimension = 1024
        elif provider == LLMProvider.DEEPSEEK:
            self.base_url = base_url or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
            self.model = model or "deepseek-chat"
            default_chat_max_tokens = _safe_positive_int(os.getenv("DEEPSEEK_MAX_TOKENS"), 8192)
            default_chat_temperature = _safe_temperature(
                os.getenv("DEEPSEEK_TEMPERATURE"),
                default_chat_temperature,
            )
            default_context_window_tokens = _safe_positive_int(
                os.getenv("DEEPSEEK_CONTEXT_WINDOW_TOKENS"),
                131072,
            )
        else:
            self.base_url = base_url or "https://api.openai.com/v1"

        self.chat_max_tokens = _safe_positive_int(
            chat_max_tokens,
            default_chat_max_tokens,
        )
        self.chat_temperature = _safe_temperature(
            chat_temperature,
            default_chat_temperature,
        )
        self.context_window_tokens = _safe_positive_int(
            context_window_tokens,
            default_context_window_tokens,
        )


def _safe_positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
        if parsed > 0:
            return parsed
    except Exception:
        pass
    return fallback


def _safe_temperature(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
        if parsed < 0:
            return 0.0
        if parsed > 2:
            return 2.0
        return parsed
    except Exception:
        return fallback


class LLMClient:
    def __init__(self, config: LLMConfig):
        self.config = config
        self._client = None
        self._logger = logging.getLogger("novelist.llm")
        self._offline_warnings: set[str] = set()

    def _warn_offline_once(self, reason: str):
        if reason in self._offline_warnings:
            return
        self._offline_warnings.add(reason)
        self._logger.warning(
            "llm offline fallback provider=%s model=%s reason=%s",
            self.config.provider.value,
            self.config.model,
            reason,
        )

    def _get_client(self):
        if self._client is not None:
            return self._client

        from openai import OpenAI
        self._client = OpenAI(
            api_key=self.config.api_key,
            base_url=self.config.base_url
        )
        return self._client

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        stream: bool = False,
    ) -> Union[str, Any]:
        if not self.config.api_key:
            self._warn_offline_once("missing_api_key")
            return self._offline_chat(messages)

        started = time.perf_counter()
        try:
            actual_max_tokens = _safe_positive_int(max_tokens, self.config.chat_max_tokens)
            actual_temperature = _safe_temperature(temperature, self.config.chat_temperature)
            client = self._get_client()
            response = client.chat.completions.create(
                model=self.config.model,
                messages=messages,
                temperature=actual_temperature,
                max_tokens=actual_max_tokens,
                stream=stream,
            )
            if stream:
                self._logger.info(
                    "llm chat remote stream provider=%s model=%s latency_ms=%.2f",
                    self.config.provider.value,
                    self.config.model,
                    (time.perf_counter() - started) * 1000,
                )
                return response
            content = response.choices[0].message.content
            self._logger.info(
                "llm chat remote success provider=%s model=%s latency_ms=%.2f chars=%d",
                self.config.provider.value,
                self.config.model,
                (time.perf_counter() - started) * 1000,
                len(content or ""),
            )
            return content
        except Exception as exc:
            self._logger.warning(
                "llm chat remote failed provider=%s model=%s error=%s fallback=offline",
                self.config.provider.value,
                self.config.model,
                exc,
            )
            return self._offline_chat(messages)

    def chat_stream_text(
        self,
        messages: List[Dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> Iterator[str]:
        if not self.config.api_key:
            self._warn_offline_once("missing_api_key")
            offline = self._offline_chat(messages)
            for ch in offline:
                yield ch
            return

        started = time.perf_counter()
        emitted_chars = 0
        try:
            response = self.chat(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
            for chunk in response:
                text = self._extract_stream_delta_text(chunk)
                if not text:
                    continue
                emitted_chars += len(text)
                yield text
            self._logger.info(
                "llm chat remote stream done provider=%s model=%s latency_ms=%.2f chars=%d",
                self.config.provider.value,
                self.config.model,
                (time.perf_counter() - started) * 1000,
                emitted_chars,
            )
        except Exception as exc:
            self._logger.warning(
                "llm chat remote stream failed provider=%s model=%s error=%s fallback=offline",
                self.config.provider.value,
                self.config.model,
                exc,
            )
            offline = self._offline_chat(messages)
            for ch in offline:
                yield ch

    def embed_text(self, text: str) -> List[float]:
        if self.config.provider == LLMProvider.MINIMAX:
            return self._embed_minimax(text)
        return self._embed_openai(text)

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        if self.config.provider == LLMProvider.MINIMAX:
            return self._embed_batch_minimax(texts)
        return self._embed_batch_openai(texts)

    def _embed_openai(self, text: str) -> List[float]:
        if not self.config.api_key:
            self._warn_offline_once("embedding_missing_api_key")
            return self._offline_embedding(text)
        try:
            client = self._get_client()
            response = client.embeddings.create(model=self.config.embedding_model, input=text)
            return response.data[0].embedding
        except Exception as exc:
            self._logger.warning(
                "embedding remote failed provider=%s model=%s error=%s fallback=offline",
                self.config.provider.value,
                self.config.embedding_model,
                exc,
            )
            return self._offline_embedding(text)

    def _embed_batch_openai(self, texts: List[str]) -> List[List[float]]:
        if not self.config.api_key:
            self._warn_offline_once("embedding_batch_missing_api_key")
            return [self._offline_embedding(text) for text in texts]
        try:
            client = self._get_client()
            response = client.embeddings.create(model=self.config.embedding_model, input=texts)
            return [item.embedding for item in response.data]
        except Exception as exc:
            self._logger.warning(
                "embedding batch remote failed provider=%s model=%s error=%s fallback=offline",
                self.config.provider.value,
                self.config.embedding_model,
                exc,
            )
            return [self._offline_embedding(text) for text in texts]

    def _embed_minimax(self, text: str) -> List[float]:
        if not self.config.api_key:
            self._warn_offline_once("embedding_missing_api_key")
            return self._offline_embedding(text, dim=self.config.embedding_dimension)
        import requests
        
        url = "https://api.minimax.chat/v1/text/embedding"
        
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": self.config.embedding_model,
            "text": text
        }
        
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            response.raise_for_status()
            data = response.json()
            return data["data"]["embedding"]
        except Exception as exc:
            self._logger.warning(
                "embedding remote failed provider=%s model=%s error=%s fallback=offline",
                self.config.provider.value,
                self.config.embedding_model,
                exc,
            )
            return self._offline_embedding(text, dim=self.config.embedding_dimension)

    def _embed_batch_minimax(self, texts: List[str]) -> List[List[float]]:
        if not self.config.api_key:
            self._warn_offline_once("embedding_batch_missing_api_key")
            return [self._offline_embedding(text, dim=self.config.embedding_dimension) for text in texts]
        import requests
        
        url = "https://api.minimax.chat/v1/text/embedding"
        
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json"
        }
        
        embeddings = []
        
        for text in texts:
            payload = {"model": self.config.embedding_model, "text": text}
            try:
                response = requests.post(url, headers=headers, json=payload, timeout=30)
                response.raise_for_status()
                data = response.json()
                embeddings.append(data["data"]["embedding"])
            except Exception as exc:
                self._logger.warning(
                    "embedding batch item remote failed provider=%s model=%s error=%s fallback=offline",
                    self.config.provider.value,
                    self.config.embedding_model,
                    exc,
                )
                embeddings.append(self._offline_embedding(text, dim=self.config.embedding_dimension))
        
        return embeddings

    def _offline_chat(self, messages: List[Dict[str, str]]) -> str:
        # Keep offline outputs compact and avoid leaking full prompts/context into user-visible drafts.
        user_parts = [m.get("content", "") for m in messages if m.get("role") == "user"]
        payload = user_parts[-1] if user_parts else ""
        instruction = ""
        if payload:
            try:
                import json

                parsed = json.loads(payload)
                instruction = str(parsed.get("instruction", "")).strip()
            except Exception:
                instruction = ""

        if "输出纯正文" in instruction or "最终章节正文" in instruction:
            return "【离线草稿】寒风掠过长街，主角在雪夜里意识到背叛已成定局。"
        if "润色" in instruction:
            return "【离线润色】句式已压缩，氛围与节奏增强，事实设定保持不变。"
        if "指出本稿可能违反设定" in instruction:
            return "【离线审校】未连接模型，建议重点核对世界规则、人物状态与时间线。"

        return "【离线占位输出】未配置可用模型，已返回最小占位结果。"

    def _extract_stream_delta_text(self, chunk: Any) -> str:
        try:
            choices = getattr(chunk, "choices", None)
            if choices:
                delta = getattr(choices[0], "delta", None)
                if delta is not None:
                    content = getattr(delta, "content", None)
                    if isinstance(content, str):
                        return content
                    if isinstance(content, list):
                        parts: List[str] = []
                        for item in content:
                            text = getattr(item, "text", None)
                            if isinstance(text, str):
                                parts.append(text)
                        return "".join(parts)
                message = getattr(choices[0], "message", None)
                if message is not None:
                    msg_content = getattr(message, "content", None)
                    if isinstance(msg_content, str):
                        return msg_content
        except Exception:
            return ""
        return ""

    def _offline_embedding(self, text: str, dim: Optional[int] = None) -> List[float]:
        import hashlib

        size = dim or self.config.embedding_dimension
        vector = [0.0] * size
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        for idx in range(size):
            vector[idx] = digest[idx % len(digest)] / 255.0
        return vector


def create_llm_client(
    provider: str = "openai",
    **kwargs
) -> LLMClient:
    candidate = (provider or "openai").strip().lower()
    try:
        llm_provider = LLMProvider(candidate)
    except ValueError:
        logging.getLogger("novelist.llm").warning(
            "unknown llm provider=%s fallback=openai",
            provider,
        )
        llm_provider = LLMProvider.OPENAI
    config = LLMConfig(provider=llm_provider, **kwargs)
    return LLMClient(config)
