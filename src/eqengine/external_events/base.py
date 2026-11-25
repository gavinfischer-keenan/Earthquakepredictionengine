"""Abstract base class for pluggable external-event providers."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import httpx


class ExternalEventProvider(ABC):
    """Interface implemented by every external-event data provider."""

    name: str
    poll_interval_sec: float

    @abstractmethod
    async def fetch(self, client: httpx.AsyncClient) -> Any:
        """Fetch and normalize latest external-event data using *client*."""
