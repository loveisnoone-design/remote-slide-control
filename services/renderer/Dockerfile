FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# LibreOffice Impress for PPTX/Keynote → PDF, Poppler for PDF → PNG.
# Fonts matter for faithful previews: Carlito/Caladea are metric-compatible with
# Calibri/Cambria, and the Thai and Noto families cover Thai and most other scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation2 \
      fonts-dejavu-core \
      fonts-thai-tlwg \
      fonts-noto-core \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY render.py app.py ./

RUN useradd --create-home renderer
USER renderer

ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
