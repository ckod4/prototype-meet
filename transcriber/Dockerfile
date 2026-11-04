FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /worker
ENV HF_HOME=/models \
    XDG_CACHE_HOME=/models \
    OMP_NUM_THREADS=4 \
    PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py ./

CMD ["python", "-u", "worker.py"]
