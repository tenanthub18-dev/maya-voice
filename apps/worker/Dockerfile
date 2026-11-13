FROM python:3.12-slim

# uv's Docker integration guide: https://docs.astral.sh/uv/guides/integration/docker/
RUN pip install --no-cache-dir uv==0.10.0 \
    && useradd --create-home --uid 10001 worker

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/apps/worker/.venv/bin:$PATH" \
    PYTHONPATH="/app/apps/worker/src"

WORKDIR /app/apps/worker

COPY apps/worker/pyproject.toml apps/worker/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY --chown=worker:worker apps/worker/src ./src
COPY --chown=worker:worker config /app/config

USER worker

EXPOSE 8080

CMD ["uvicorn", "voice_receptionist_worker.main:app", "--host", "0.0.0.0", "--port", "8080"]
