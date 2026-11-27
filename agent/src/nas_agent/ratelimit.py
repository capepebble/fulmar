"""Limites de débit : appels par jeton, échecs d'authentification par adresse."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Callable


class RateLimiter:
    """Fenêtre glissante : au plus `limit` événements par `window` secondes et par clé."""

    def __init__(
        self, limit: int, window: float = 60.0, clock: Callable[[], float] = time.monotonic
    ):
        self.limit = limit
        self.window = window
        self.clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def _trim(self, key: str, now: float) -> deque[float]:
        events = self._events[key]
        while events and events[0] <= now - self.window:
            events.popleft()
        return events

    def check(self, key: str) -> bool:
        """Compte un événement s'il reste de la place ; rend False sinon."""
        now = self.clock()
        events = self._trim(key, now)
        if len(events) >= self.limit:
            return False
        events.append(now)
        return True


class Lockout:
    """Bloque une adresse pendant `duration` s après `failures` échecs en `window` s."""

    def __init__(
        self,
        failures: int,
        window: float,
        duration: float,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._failures = failures
        self._window = window
        self._duration = duration
        self._clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._locked_until: dict[str, float] = {}
        self._logged: set[str] = set()

    def should_log(self, key: str) -> bool:
        """Un seul refus journalisé par période de blocage et par adresse."""
        if key in self._logged:
            return False
        self._logged.add(key)
        return True

    def is_locked(self, key: str) -> bool:
        until = self._locked_until.get(key)
        if until is None:
            return False
        if self._clock() >= until:
            del self._locked_until[key]
            self._events.pop(key, None)
            self._logged.discard(key)
            return False
        return True

    def failure(self, key: str) -> None:
        now = self._clock()
        events = self._events[key]
        while events and events[0] <= now - self._window:
            events.popleft()
        events.append(now)
        if len(events) >= self._failures:
            self._locked_until[key] = now + self._duration
        if len(self._events) > 10_000:  # borne la mémoire face à des adresses changeantes
            for k in [
                k for k, ev in self._events.items() if not ev or ev[-1] <= now - self._window
            ]:
                del self._events[k]
