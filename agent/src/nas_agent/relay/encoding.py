"""Encodages et adresses du protocole du relais, sans aucune cryptographie.

Séparés de `protocol.py` pour que le moteur tourne sans PyNaCl : le registre des téléphones,
le client HTTP et la lecture des réglages s'en servent aussi quand le module du relais est
absent.
"""

from __future__ import annotations

import base64
import binascii
import ipaddress
import re
from typing import Any
from urllib.parse import urlsplit

_B64U = re.compile(r"^[A-Za-z0-9_-]*$")

_PRIVATE_NETS = tuple(
    ipaddress.ip_network(n)
    for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fd00::/8")
)


class ProtocolError(ValueError):
    """Message mal formé, signature fausse ou contenu illisible : à refuser sans détail."""


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: Any, length: int | None = None) -> bytes:
    """Décodage strict : alphabet base64url, sans « = », forme canonique, longueur exacte."""
    if not isinstance(text, str) or not _B64U.match(text) or len(text) % 4 == 1:
        raise ProtocolError("base64url invalide")
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise ProtocolError("base64url invalide") from None
    if b64u(data) != text:
        raise ProtocolError("base64url non canonique")
    if length is not None and len(data) != length:
        raise ProtocolError("longueur inattendue")
    return data


def url_allowed(url: str, *, private: bool) -> bool:
    """Section 6.2 : https, ou http vers la boucle locale ; pour une adresse directe
    (`private`), http aussi vers une adresse privée ou un nom en .local."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018 - lève ValueError sur un port invalide
    except ValueError:
        return False
    if not host or parts.username or parts.password:
        return False
    if parts.scheme == "https":
        return True
    if parts.scheme != "http":
        return False
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return private and host.endswith(".local")
    if ip.is_loopback:
        return True
    return private and any(ip in net for net in _PRIVATE_NETS)
