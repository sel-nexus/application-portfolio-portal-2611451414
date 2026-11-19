"""Read the API's environment contract without opening external resources."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Resolve per-process configuration from environment and a local .env file."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    MONGODB_URI: str = "mongodb://127.0.0.1:27017"
    MONGODB_DB: str = "portfolio_portal"
    JWT_SECRET: str = "dev-secret-change-in-production"
    CORS_ORIGINS: str = "http://localhost:5173"
    SEED_ON_STARTUP: bool = True

    @property
    def cors_origins(self) -> list[str]:
        """Return explicit allowed browser origins, omitting blank entries."""
        return [value.strip() for value in self.CORS_ORIGINS.split(",") if value.strip()]

    def validate_secret(self) -> None:
        """Refuse public or short signing keys before accepting sessions.

        Raises:
            RuntimeError: The configured key is not suitable for signing.
        """
        if len(self.JWT_SECRET) < 32 or self.JWT_SECRET == "dev-secret-change-in-production":
            raise RuntimeError("JWT_SECRET must be a randomly generated secret of at least 32 characters")
