FROM python:3.10-slim

# Prevent python from writing pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system dependencies for OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy python dependencies list and install
COPY requirements.txt .
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

# Baixa os pesos YOLO na hora do build. Sem esta etapa o ultralytics tenta
# busca-los no GitHub na primeira inferencia — o que derruba a engine em
# qualquer loja cujo appliance suba sem acesso a internet. Os nomes precisam
# acompanhar POSE_MODEL_PATH/OBJ_MODEL_PATH em edge/vision_engine.py.
ENV YOLO_CONFIG_DIR=/app/.ultralytics
RUN python -c "\
from ultralytics import YOLO; \
YOLO('yolo26n-pose.pt'); \
YOLO('yolo26s.pt'); \
print('[BUILD] Pesos YOLO embutidos na imagem.')"

# Copy the entire codebase
COPY . .

# Expose ports:
# 8000 for API Data Bridge
# 8090 for webhook endpoints (if different)
EXPOSE 8000 8090

# Launch the services coordinator
CMD ["python", "entrypoint.py"]
