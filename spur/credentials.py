"""Provider credentials stay on the server. Windows saves use per-user DPAPI."""
import ctypes
import os
from pathlib import Path
from ctypes import wintypes

ENV_KEYS = {"openai": "OPENAI_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def protect(data: bytes, decrypt=False):
    if os.name != "nt":
        raise ValueError("Set the provider API key as an environment variable on this operating system")
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = Blob(len(data), buffer)
    output = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    blob_pointer = ctypes.POINTER(Blob)
    crypt.CryptProtectData.argtypes = [blob_pointer, wintypes.LPCWSTR, blob_pointer, ctypes.c_void_p,
                                      ctypes.c_void_p, wintypes.DWORD, blob_pointer]
    crypt.CryptProtectData.restype = wintypes.BOOL
    crypt.CryptUnprotectData.argtypes = [blob_pointer, ctypes.c_void_p, blob_pointer, ctypes.c_void_p,
                                        ctypes.c_void_p, wintypes.DWORD, blob_pointer]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    # CRYPTPROTECT_UI_FORBIDDEN: never prompts on an unattended worker.
    if decrypt:
        success = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    else:
        success = crypt.CryptProtectData(ctypes.byref(source), "Spur Ring provider key", None, None, None, 1, ctypes.byref(output))
    if not success:
        raise ValueError(f"Windows could not access the encrypted provider credential (error {ctypes.get_last_error()}). Use an API-key environment variable if the account profile is unavailable.")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def key_path(settings, provider):
    if provider not in ENV_KEYS:
        raise ValueError("Unsupported hosted provider")
    return Path(settings.db_path).parent / "credentials" / f"{provider}.dpapi"


def save_key(settings, provider, key):
    encrypted = protect(key.encode("utf-8"))
    path = key_path(settings, provider)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(encrypted)
    temporary.replace(path)


def load_key(settings, provider):
    if provider not in ENV_KEYS:
        return ""
    # Explicit environment configuration takes precedence over saved credentials.
    key = os.getenv(ENV_KEYS[provider], "") if settings.allow_env_keys else ''
    if key:
        return key
    path = key_path(settings, provider)
    return protect(path.read_bytes(), decrypt=True).decode("utf-8") if path.exists() else ""


def selected_connection(store, settings):
    if getattr(store,'profile_parent',None):
        return store.get_runtime('model_override',None) or selected_connection(store.profile_parent,settings)
    return store.get_runtime("connection", {"provider": settings.provider,
                            "model": store.get_runtime("model", settings.model)})
