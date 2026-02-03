FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
    torch==2.0.1 torchaudio==2.0.2 && \
    pip install --no-cache-dir -r requirements.txt gunicorn

COPY demucs ./demucs

ENV WEB_JOBS_ROOT=/data/web_jobs

CMD ["gunicorn", "--workers", "1", "--threads", "4", "--timeout", "3600", "--bind", "0.0.0.0:8080", "demucs.webapp:app"]
