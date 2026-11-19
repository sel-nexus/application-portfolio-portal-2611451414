"""Validate all maintained application fields at the API boundary."""

from typing import Annotated, Literal
from bson import ObjectId
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, HttpUrl, field_validator

Criticality = Literal["Low", "Medium", "High", "Critical"]
Lifecycle = Literal["Active", "Deprecated", "Retired"]
Risk = Literal["Low", "Medium", "High"]
Score = Annotated[int, Field(strict=True, ge=0, le=100)]
Count = Annotated[int, Field(strict=True, ge=0)]


class ApplicationPayload(BaseModel):
    """Reject unknown fields, noninteger metrics, unsafe links, and invalid defects."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=200)
    portfolioId: str
    description: str = Field(default="", max_length=5000)
    productArea: str = Field(default="", max_length=200)
    businessOwner: str = Field(default="", max_length=200)
    technologyOwner: str = Field(default="", max_length=200)
    qualityOwner: str = Field(default="", max_length=200)
    criticality: Criticality = "Low"
    tier: Annotated[int, Field(strict=True, ge=1, le=4)] = 1
    lifecycle: Lifecycle = "Active"
    technologyStack: str = Field(default="", max_length=2000)
    repositoryLink: str = Field(default="", max_length=2000)
    pipelineLink: str = Field(default="", max_length=2000)
    healthScore: Score = 0
    qualityScore: Score = 0
    automationCoverage: Score = 0
    unitTestCoverage: Score = 0
    openDefects: Count = 0
    openCriticalDefects: Count = 0
    risk: Risk = "Low"

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        """Require visible text without control characters."""
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Enter a valid application name")
        return value

    @field_validator("portfolioId")
    @classmethod
    def valid_portfolio(cls, value: str) -> str:
        """Require a database reference rather than a query operator."""
        if not ObjectId.is_valid(value):
            raise ValueError("Select a valid portfolio")
        return value

    @field_validator("repositoryLink", "pipelineLink")
    @classmethod
    def valid_link(cls, value: str) -> str:
        """Accept empty links or browser-safe absolute HTTP and HTTPS URLs."""
        if value:
            TypeAdapter(HttpUrl).validate_python(value)
        return value

    @field_validator("openCriticalDefects")
    @classmethod
    def valid_defects(cls, value: int, info) -> int:
        """Attach cross-field defect errors to the critical-defects control."""
        if value > info.data.get("openDefects", value):
            raise ValueError("Open critical defects cannot exceed open defects")
        return value


class ApplicationDetail(ApplicationPayload):
    """Expose public persisted facts with the current referenced portfolio name."""

    id: str
    portfolio: str


class PortfolioOption(BaseModel):
    """Expose a visible portfolio choice without private inventory fields."""

    id: str
    name: str


class ApplicationPage(BaseModel):
    """Return a bounded result and options derived only from the permitted scope."""

    items: list[ApplicationDetail]
    total: int
    page: int
    page_size: int
    portfolios: list[PortfolioOption]
    criticalities: list[Criticality]
    risks: list[Risk]
    lifecycles: list[Lifecycle]
