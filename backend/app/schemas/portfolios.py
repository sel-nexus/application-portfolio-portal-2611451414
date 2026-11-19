"""Validate portfolio maintenance and expose only public inventory fields."""

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class PortfolioPayload(BaseModel):
    """Accept the five maintained fields, rejecting operator objects and extras."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    owner: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=5000)
    productArea: str = Field(default="", max_length=200)
    status: Literal["Active", "Archived"] = "Active"

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        """Require visible name text without control characters."""
        if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Enter a valid portfolio name")
        return value


class PortfolioSummary(PortfolioPayload):
    """Expose persisted fields and scores computed from stored applications."""

    id: str
    applicationCount: int
    qualityScore: int


class PortfolioApplication(BaseModel):
    """Expose an associated application's identifier and name only."""

    id: str
    name: str


class PortfolioDetail(PortfolioSummary):
    """Include application names in an authorized portfolio detail."""

    applications: list[PortfolioApplication]


class PortfolioPage(BaseModel):
    """Return a bounded page with scope-safe filter options."""

    items: list[PortfolioSummary]
    total: int
    page: int
    page_size: int
    productAreas: list[str]
    statuses: list[Literal["Active", "Archived"]]
