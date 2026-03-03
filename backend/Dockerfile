FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    POETRY_VERSION=1.8.3 \
    POETRY_VIRTUALENVS_CREATE=false

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml poetry.lock ./
RUN pip install --upgrade pip \
    && pip install "poetry==${POETRY_VERSION}" \
    && poetry install --only main --no-root

COPY . .
RUN chmod +x scripts/run_api.sh

EXPOSE 8000
CMD ["./scripts/run_api.sh"]
