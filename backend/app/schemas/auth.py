"""Define strict identity payloads and secret-free response contracts."""

import re
from datetime import datetime
from typing import Annotated, Literal
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

PyObjectId = Annotated[str, BeforeValidator(str)]
Landing = Literal["Dashboard", "Applications"]
RoleName = Literal["Administrator", "Executive", "Portfolio Leader", "Engineer", "Auditor", "Read Only"]


class Payload(BaseModel):
    """Reject extra input fields and implicit scalar type conversions."""

    model_config = ConfigDict(extra="forbid", strict=True)


class LoginRequest(Payload):
    """Accept local email credentials, including designated .local demo accounts."""

    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        """Normalize email for the unique lookup without requiring a public TLD."""
        value = value.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Enter a valid email")
        return value

    @field_validator("password")
    @classmethod
    def bounded_password(cls, value: str) -> str:
        """Reject bcrypt-truncated credentials before verification."""
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return value


class ProfileRequest(Payload):
    """Allow only the person's landing preference to change."""

    defaultLanding: Landing


class PasswordRequest(Payload):
    """Collect proof of the existing password and confirmed replacement."""

    currentPassword: str = Field(min_length=1)
    newPassword: str = Field(min_length=1)
    confirmation: str = Field(min_length=1)

    @field_validator("currentPassword", "newPassword", "confirmation")
    @classmethod
    def bounded_password(cls, value: str) -> str:
        """Reject values whose UTF-8 representation exceeds bcrypt's limit."""
        return LoginRequest.bounded_password(value)


class PublicUser(BaseModel):
    """Expose current account facts and role permissions, never credential fields."""

    id: PyObjectId
    name: str
    email: str
    role: RoleName
    permissions: list[str]
    portfolioAccess: list[PyObjectId]
    portfolioNames: list[str]
    status: Literal["Active", "Inactive"]
    managerName: str
    vendor: bool
    mustChangePassword: bool
    defaultLanding: Landing
    lastSignIn: datetime | None = None


class AuthResponse(BaseModel):
    """Return a server-issued bearer session and current public account."""

    token: str
    user: PublicUser
