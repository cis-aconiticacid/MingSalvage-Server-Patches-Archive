FROM python:3.11-slim

WORKDIR /app

COPY .backend_deps/ .backend_deps/
COPY MingSalvageBackend.exe_extracted/ MingSalvageBackend.exe_extracted/
COPY resources/ resources/
COPY run_ming_backend.py .
COPY password.txt .
COPY entrypoint.sh .

RUN pip install --no-cache-dir uvicorn fastapi && chmod +x entrypoint.sh

ENV MING_SIM_NO_SSL=1
ENV MING_SIM_ELECTRON=1
ENV MING_SIM_USER_DATA_DIR=/app/persist/data
ENV PYTHONUNBUFFERED=1
ENV PYTHONIOENCODING=utf-8

EXPOSE 53345

ENTRYPOINT ["./entrypoint.sh"]
