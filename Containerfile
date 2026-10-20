FROM docker.io/library/node:24-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM docker.io/library/python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
WORKDIR /app/server
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-cache
COPY server/app.py ./
COPY --from=web /src/web/dist /app/web/dist
USER 65534
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "exec .venv/bin/uvicorn app:create_app --factory --host \"$HOST\" --port \"$PORT\""]
