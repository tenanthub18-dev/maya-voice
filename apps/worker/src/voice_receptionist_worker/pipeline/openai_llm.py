"""Own each call's native OpenAI pool, with optional metadata preconnect."""

import asyncio
from dataclasses import replace

from loguru import logger
from openai import NOT_GIVEN as OPENAI_NOT_GIVEN
from pipecat.frames.frames import Frame, InterruptionFrame, StartFrame
from pipecat.services.openai.llm import OpenAILLMService as PipecatOpenAILLMService
from pipecat.services.settings import ServiceSettings, is_given


class OpenAILLMService(PipecatOpenAILLMService):
    """Preserve the native client/settings and close per-call resources."""

    def __init__(self, *, preconnect: bool = False, **kwargs):
        if type(preconnect) is not bool:
            raise ValueError("preconnect must be a boolean")
        self._preconnect_task: asyncio.Task[None] | None = None
        self._preconnect_closing = False
        super().__init__(**kwargs)
        if preconnect:
            # Pipecat 1.14.0: this public hook runs after interruption cancellation.
            # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/processors/frame_processor.py
            self.add_event_handler("on_after_process_frame", self._schedule_preconnect)

    async def _schedule_preconnect(self, service, frame: Frame):
        if (
            not isinstance(frame, (StartFrame, InterruptionFrame))
            or self._preconnect_closing
            or self._client.is_closed()
            or (self._preconnect_task is not None and not self._preconnect_task.done())
        ):
            return
        self._preconnect_task = asyncio.create_task(self._preconnect(self._settings.model))

    async def _preconnect(self, model: str):
        try:
            # Installed openai 3.39.0: with_options shares the native HTTP client;
            # AsyncModels.retrieve accepts a per-request timeout in seconds.
            # Metadata GET only: https://developers.openai.com/api/reference/resources/models/methods/retrieve
            await self._client.with_options(max_retries=0).models.retrieve(model, timeout=0.8)
        except Exception:
            # Never log provider exception bodies, caller content, or credentials.
            logger.debug("OpenAI metadata preconnect failed")

    async def _update_settings(self, delta: ServiceSettings):
        if is_given(delta.model) and delta.model != self._settings.model:
            # Pipecat merges extra; all extras here are model-specific. OpenAI's
            # NOT_GIVEN omits stale fields on the wire. Copy, never mutate delta.
            # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/settings.py
            delta = replace(delta, extra={
                **{key: OPENAI_NOT_GIVEN for key in self._settings.extra},
                **delta.extra,
            })
        return await super()._update_settings(delta)

    # Pipecat 1.14.0 does not close its SDK client in cleanup:
    # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/openai/base_llm.py
    async def cleanup(self):
        self._preconnect_closing = True
        try:
            await super().cleanup()
        finally:
            try:
                if self._preconnect_task is not None:
                    self._preconnect_task.cancel()
                    await asyncio.gather(self._preconnect_task, return_exceptions=True)
                    self._preconnect_task = None
            finally:
                if not self._client.is_closed():
                    await self._client.close()
