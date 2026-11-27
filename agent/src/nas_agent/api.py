"""API REST : une route par opération du catalogue, générée, plus /v1/ops et /healthz."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, create_model
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp

from nas_agent import __version__
from nas_agent.auth import Authenticator, client_ip
from nas_agent.catalog.model import Catalog, Operation
from nas_agent.config import Settings
from nas_agent.engine import Engine, Envelope, OpError
from nas_agent.i18n import requested_lang
from nas_agent.tokens import Principal

PROBLEM = "application/problem+json"


def problem(status: int, code: str, detail: str, dsm_code: int | None = None) -> JSONResponse:
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": code,
        "status": status,
        "code": code,
        "detail": detail,
    }
    if dsm_code is not None:
        body["dsm_code"] = dsm_code
    headers = {"WWW-Authenticate": 'Bearer realm="nas-agent"'} if status == 401 else None
    return JSONResponse(body, status_code=status, media_type=PROBLEM, headers=headers)


def envelope_json(env: Envelope) -> dict[str, Any]:
    return {
        "op": env.op,
        "fetched_at": env.fetched_at.isoformat(),
        "cached": env.cached,
        "data": env.data,
    }


def envelope_model(op: Operation) -> type[BaseModel]:
    name = "".join(part.capitalize() for part in op.id.replace("_", ".").split(".")) + "Response"
    return create_model(
        name,
        op=(str, ...),
        fetched_at=(datetime, ...),
        cached=(bool, ...),
        data=(op.result_model, ...),
    )


def _query_parameters(op: Operation) -> list[dict[str, Any]]:
    if op.params_model is None:
        return []
    schema = op.params_model.model_json_schema()
    required = set(schema.get("required", []))
    return [
        {
            "name": name,
            "in": "query",
            "required": name in required,
            "description": prop.get("description", ""),
            "schema": {k: v for k, v in prop.items() if k != "description"},
        }
        for name, prop in schema.get("properties", {}).items()
    ]


def allowed_hosts(settings: Settings) -> list[str]:
    """En-têtes Host admis : le nom public sur le tailnet, et la boucle locale."""
    return [*settings.public_hosts, "127.0.0.1", "127.0.0.2", "localhost", "[::1]"]


def create_app(
    settings: Settings,
    engine: Engine,
    catalog: Catalog,
    authenticator: Authenticator,
    *,
    mcp_app: ASGIApp | None = None,
    lifespan: Callable[[FastAPI], AbstractAsyncContextManager[None]] | None = None,
) -> FastAPI:
    app = FastAPI(
        title="nas-agent",
        version=__version__,
        description="Read-only API of a Synology NAS. Every call requires a bearer token.",
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        redirect_slashes=False,
        lifespan=lifespan,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts(settings))

    def ip_of(request: Request) -> str:
        peer = request.client.host if request.client else None
        return client_ip(peer, request.headers, settings.trusted_proxies)

    def principal_of(request: Request, op: str | None = None) -> Principal:
        return authenticator.authenticate(
            request.headers.get("authorization"), ip_of(request), "rest", op
        )

    @app.exception_handler(OpError)
    async def _op_error(_request: Request, exc: OpError) -> JSONResponse:
        return problem(exc.status, exc.code, exc.detail, exc.dsm_code)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "invalid_request"
        return problem(
            exc.status_code,
            code,
            "Unknown resource." if code == "not_found" else "Request refused.",
        )

    @app.exception_handler(Exception)
    async def _unexpected(_request: Request, _exc: Exception) -> JSONResponse:
        # Jamais de trace interne vers l'appelant.
        return problem(500, "internal", "Internal agent error.")

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/ops", summary="Operations this token may call")
    async def list_ops(request: Request) -> list[dict[str, Any]]:
        principal = principal_of(request)
        engine.admit(principal, channel="rest", client_ip=ip_of(request), label="meta.ops")
        return [
            {
                "id": op.id,
                "title": op.title,
                "description": op.description,
                "kind": op.kind,
                "scope": op.scope,
                "personal": op.personal,
                "method": "GET" if op.kind == "read" else "POST",
                "path": f"/v1{op.path}",
                "verified_on": op.verified_on,
            }
            for op in catalog.visible_to(principal)
        ]

    @app.get("/v1/openapi.json", include_in_schema=False)
    async def openapi(request: Request) -> JSONResponse:
        principal = principal_of(request)
        engine.admit(principal, channel="rest", client_ip=ip_of(request), label="meta.openapi")
        return JSONResponse(app.openapi())

    for op in catalog:
        _add_route(app, op, engine, principal_of, ip_of)

    _secure_openapi(app)
    if mcp_app is not None:
        # Route exacte (pas de Mount) : « /mcp » sans redirection vers « /mcp/ ».
        app.router.routes.append(Route("/mcp", endpoint=mcp_app, methods=["GET", "POST", "DELETE"]))
    return app


def _secure_openapi(app: FastAPI) -> None:
    build = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            schema = build()
            schema.setdefault("components", {})["securitySchemes"] = {
                "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "nag_<id>_<secret>"}
            }
            schema["security"] = [{"bearer": []}]
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]


def _add_route(app: FastAPI, op: Operation, engine: Engine, principal_of, ip_of) -> None:
    async def endpoint(request: Request) -> JSONResponse:
        principal = principal_of(request, op.id)
        env = await engine.run(
            op.id,
            dict(request.query_params),
            principal,
            channel="rest",
            client_ip=ip_of(request),
            lang=requested_lang(request.headers.get("accept-language")),
        )
        return JSONResponse(envelope_json(env))

    endpoint.__name__ = op.tool_name
    app.add_api_route(
        f"/v1{op.path}",
        endpoint,
        methods=["GET"] if op.kind == "read" else ["POST"],
        response_model=envelope_model(op),
        summary=op.title,
        description=op.description,
        tags=[op.scope],
        openapi_extra={
            "parameters": _query_parameters(op),
            "security": [{"bearer": []}],
            "x-nas-agent": {"op": op.id, "personal": op.personal, "verified_on": op.verified_on},
        },
    )
