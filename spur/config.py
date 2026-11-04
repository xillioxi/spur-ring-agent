import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str = os.getenv("SPUR_DB", "data/spur.db")
    api_key: str = os.getenv("SPUR_API_KEY", "")
    ollama_url: str = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
    model: str = os.getenv("OLLAMA_MODEL", "")
    local_ui: bool = os.getenv("SPUR_LOCAL_UI", "0") == "1"
    provider: str = os.getenv("SPUR_PROVIDER", "ollama")
    allow_env_keys: bool = True


settings = Settings()
