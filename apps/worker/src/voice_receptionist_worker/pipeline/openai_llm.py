"""Own and close each call's existing Pipecat OpenAI client."""

from pipecat.services.openai.llm import OpenAILLMService as PipecatOpenAILLMService


class OpenAILLMService(PipecatOpenAILLMService):
    """Preserve the native client/settings and close per-call resources."""

    # Pipecat 1.14.0 does not close its SDK client in cleanup:
    # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/openai/base_llm.py
    async def cleanup(self):
        try:
            await super().cleanup()
        finally:
            if not self._client.is_closed():
                await self._client.close()
