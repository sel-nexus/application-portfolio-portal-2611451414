"""Define credential-free audit inspection contracts."""

from datetime import date, datetime
from pydantic import BaseModel, Field


class AuditFilters(BaseModel):
    """Carry literal actor/action filters and UTC calendar dates."""

    person: str | None = Field(default=None, max_length=200)
    action: str | None = Field(default=None, max_length=200)
    from_date: date | None = None
    to_date: date | None = None


class AuditEvent(BaseModel):
    """Expose only event facts, never arbitrary persisted payload fields."""

    id: str
    time: datetime
    person: str
    action: str
    entityType: str
    entityId: str | None = None
    summary: str


class AuditPage(BaseModel):
    """Return bounded history and useful choices from authorized history."""

    items: list[AuditEvent]
    total: int
    page: int
    page_size: int
    persons: list[str]
    actions: list[str]
