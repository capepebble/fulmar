"""Assemblage du catalogue : chaque module déclare sa liste OPERATIONS."""

from __future__ import annotations

from nas_agent.catalog.model import Catalog
from nas_agent.catalog.ops import (
    access,
    accounts,
    activebackup,
    activebackup_cloud,
    activity,
    advisories,
    agent,
    backup,
    certificates,
    checks,
    close_access,
    connections,
    containers,
    devices,
    logs,
    metrics,
    network,
    packages,
    report,
    security,
    services,
    shares,
    smart,
    storage,
    system,
    updates,
    ups,
)


def build_catalog() -> Catalog:
    return Catalog(
        [
            *agent.OPERATIONS,
            *access.OPERATIONS,
            *close_access.OPERATIONS,
            *system.OPERATIONS,
            *storage.OPERATIONS,
            *smart.OPERATIONS,
            *metrics.OPERATIONS,
            *shares.OPERATIONS,
            *backup.OPERATIONS,
            *activebackup.OPERATIONS,
            *activebackup_cloud.OPERATIONS,
            *packages.OPERATIONS,
            *advisories.OPERATIONS,
            *updates.OPERATIONS,
            *security.OPERATIONS,
            *services.OPERATIONS,
            *certificates.OPERATIONS,
            *network.OPERATIONS,
            *ups.OPERATIONS,
            *containers.OPERATIONS,
            *accounts.OPERATIONS,
            *logs.OPERATIONS,
            *activity.OPERATIONS,
            *connections.OPERATIONS,
            *checks.OPERATIONS,
            *report.OPERATIONS,
            *devices.OPERATIONS,
        ]
    )
