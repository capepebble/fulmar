# Image de l'agent : construite depuis agent/ (docker build -f deploy/Dockerfile .)
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.3 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
# WITH_RELAY=0 : sans PyNaCl, donc sans le relais des téléphones (moteur publié avant le
# classement « grand public » de l'ANSSI) ; l'agent tourne alors sans lui. Le moteur publié n'a
# déjà plus de groupe « relay » : l'option n'est passée que si le groupe existe.
ARG WITH_RELAY=1
COPY pyproject.toml uv.lock ./
RUN groups=$([ "$WITH_RELAY" = 1 ] || ! grep -q '^relay = \[' pyproject.toml || echo "--no-group relay") \
    && uv sync --frozen --no-dev $groups --no-install-project
COPY src ./src
RUN groups=$([ "$WITH_RELAY" = 1 ] || ! grep -q '^relay = \[' pyproject.toml || echo "--no-group relay") \
    && uv sync --frozen --no-dev $groups --no-editable

FROM python:3.13-slim
# /shared : le jeton de la console dans le projet du moteur ; un volume nommé y prend ce
# propriétaire à sa création.
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin agent \
    && mkdir -p /data /shared && chown 10001:10001 /data /shared
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH \
    NAS_AGENT_DATA_DIR=/data \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER 10001
VOLUME ["/data"]
ENTRYPOINT ["nas-agent"]
CMD ["serve"]
