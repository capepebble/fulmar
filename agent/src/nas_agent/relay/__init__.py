"""Module relay : appairage des téléphones, dépôts chiffrés au relais, lecture directe.

Facultatif : sans PyNaCl, ou sans le code du chiffrement (moteur publié avant le classement
« grand public » de l'ANSSI), le moteur tourne sans lui. Les encodages (`encoding`), le
registre des téléphones (`store`), l'état (`state`) et les règles d'alerte (`alerts`) ne
chiffrent rien et restent.
"""

from __future__ import annotations

import importlib.util

# Les modules qui chiffrent ou qui en dépendent : absents du moteur publié sans relais.
CRYPTO_MODULES = ("protocol", "identity", "service", "direct", "cli", "demo")


def available() -> bool:
    """PyNaCl et le code du chiffrement du relais sont là."""
    try:
        if importlib.util.find_spec("nacl") is None:
            return False
        return all(
            importlib.util.find_spec(f"nas_agent.relay.{name}") is not None
            for name in CRYPTO_MODULES
        )
    except (ImportError, ValueError):
        return False
