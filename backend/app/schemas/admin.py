"""Validate administered accounts and stable role configuration."""

from typing import Literal
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator
from app.schemas.auth import Payload, LoginRequest, PublicUser, RoleName, PyObjectId

Permission = Literal["view", "create", "edit", "delete", "export", "administer"]


class UserPayload(Payload):
    """Collect full account maintenance without credential or profile overrides."""

    name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=1, max_length=254)
    role: RoleName
    portfolioAccess: list[str] = Field(max_length=100)
    status: Literal["Active", "Inactive"]
    managerName: str = Field(max_length=200)
    vendor: bool

    @field_validator("name", "managerName")
    @classmethod
    def clean_text(cls, value: str) -> str:
        """Trim facts and reject control characters in single-line fields."""
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Enter single-line text")
        return value.strip()

    @field_validator("name")
    @classmethod
    def required_name(cls, value: str) -> str:
        """Reject whitespace-only names."""
        if not value:
            raise ValueError("Name is required")
        return value

    @field_validator("email")
    @classmethod
    def email_address(cls, value: str) -> str:
        """Normalize the unique email using the existing local-email contract."""
        return LoginRequest.normalize_email(value)

    @field_validator("portfolioAccess")
    @classmethod
    def references(cls, values: list[str]) -> list[str]:
        """Reject malformed or repeated portfolio identifiers before querying."""
        if any(not ObjectId.is_valid(value) for value in values):
            raise ValueError("Select valid portfolios")
        normalized = [str(ObjectId(value)) for value in values]
        if len(set(normalized)) != len(normalized):
            raise ValueError("Select each portfolio once")
        return normalized


class UserCreate(UserPayload):
    """Accept an initial password only while creating an account."""

    initialPassword: str = Field(min_length=1)

    @field_validator("initialPassword")
    @classmethod
    def password(cls, value: str) -> str:
        """Enforce bcrypt's byte limit without inventing complexity requirements."""
        return LoginRequest.bounded_password(value)


class UserPage(BaseModel):
    """Expose a bounded secret-free account page."""

    items: list[PublicUser]
    total: int
    page: int
    page_size: int


class RolePayload(Payload):
    """Allow only description and the six supported permission choices."""

    description: str = Field(max_length=5000)
    permissions: list[Permission] = Field(max_length=6)

    @field_validator("permissions")
    @classmethod
    def unique_permissions(cls, values: list[Permission]) -> list[Permission]:
        """Reject repeated permission selections."""
        if len(set(values)) != len(values):
            raise ValueError("Select each permission once")
        return values


class PublicRole(BaseModel):
    """Expose the stable role identifier, name, description and configuration."""

    id: PyObjectId
    name: RoleName
    description: str
    permissions: list[Permission]
