import os
import sys
import hashlib
import hmac
import contextlib
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEPS = ROOT / ".backend_deps"
EXTRACTED = ROOT / "MingSalvageBackend.exe_extracted" / "PYZ.pyz_extracted"
INTERNAL = ROOT / "resources" / "backend" / "MingSalvageBackend" / "_internal"
DATA = ROOT / ".ming_backend_data"
PASSWORD_FILE = ROOT / "password.txt"

sys.path[:0] = [str(DEPS), str(EXTRACTED)]

# The extracted backend was packaged with PyInstaller. These flags make its
# resource lookup code use the bundled content/web folders already present here.
sys.frozen = True
sys._MEIPASS = str(INTERNAL)

os.environ.setdefault("MING_SIM_ELECTRON", "1")
os.environ.setdefault("MING_SIM_USER_DATA_DIR", str(DATA))
os.environ.setdefault("PYTHONUNBUFFERED", "1")
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")


def detach_standard_streams() -> None:
    if os.environ.get("MING_SIM_KEEP_STDIO") == "1":
        return
    if sys.stdout and sys.stderr and sys.stdout.isatty() and sys.stderr.isatty():
        return
    log_path = ROOT / "ming_backend.log"
    stream = open(log_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream


if __name__ == "__main__":
    detach_standard_streams()

    import uvicorn
    import web_app
    from fastapi import Request
    from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

    AUTH_COOKIE = "ming_auth"

    def read_password() -> str:
        try:
            return PASSWORD_FILE.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return ""

    def auth_token(password: str) -> str:
        return hmac.new(b"ming-salvage-auth-v1", password.encode("utf-8"), hashlib.sha256).hexdigest()

    def login_page(error: str = "") -> HTMLResponse:
        message = "<p class='error'>密码不正确</p>" if error else ""
        return HTMLResponse(
            f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>请输入密码</title>
    <style>
      html, body {{ width: 100%; height: 100%; margin: 0; }}
      body {{
        display: grid;
        place-items: center;
        background: #17130e;
        color: #f2e5c7;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      form {{
        width: min(88vw, 360px);
        display: grid;
        gap: 14px;
        padding: 26px;
        border: 1px solid rgba(214, 171, 91, .38);
        border-radius: 8px;
        background: #251d14;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .35);
      }}
      h1 {{ margin: 0; font-size: 20px; font-weight: 700; }}
      input, button {{
        height: 44px;
        border-radius: 6px;
        font: inherit;
        box-sizing: border-box;
      }}
      input {{
        width: 100%;
        border: 1px solid rgba(214, 171, 91, .42);
        background: #100d09;
        color: #fff4d8;
        padding: 0 12px;
      }}
      button {{
        border: 0;
        background: #b67a2d;
        color: #140d06;
        font-weight: 700;
        cursor: pointer;
      }}
      .error {{ margin: 0; color: #ffb7a8; font-size: 14px; }}
    </style>
  </head>
  <body>
    <form method="post" action="/__password_login">
      <h1>请输入访问密码</h1>
      {message}
      <input name="password" type="password" autocomplete="current-password" autofocus />
      <button type="submit">进入游戏</button>
    </form>
  </body>
</html>""",
            status_code=401 if error else 200,
        )

    @web_app.app.middleware("http")
    async def password_gate(request: Request, call_next):
        if request.url.path == "/__password_login":
            if request.method == "POST":
                password = read_password()
                form = await request.form()
                supplied = str(form.get("password", ""))
                if password and hmac.compare_digest(supplied, password):
                    response = RedirectResponse("/", status_code=303)
                    response.set_cookie(
                        AUTH_COOKIE,
                        auth_token(password),
                        httponly=True,
                        secure=use_ssl,
                        samesite="lax",
                        max_age=60 * 60 * 24 * 30,
                    )
                    return response
                return login_page("bad-password")
            return login_page()

        password = read_password()
        if not password:
            return await call_next(request)

        expected = auth_token(password)
        supplied = request.cookies.get(AUTH_COOKIE, "")
        if hmac.compare_digest(supplied, expected):
            return await call_next(request)

        if request.method == "GET":
            return login_page()
        return JSONResponse({"detail": "password required"}, status_code=401)

    certfile = os.environ.get("MING_SIM_SSL_CERTFILE", str(ROOT / "fullchain.pem"))
    keyfile = os.environ.get("MING_SIM_SSL_KEYFILE", str(ROOT / "key.pem"))
    use_ssl = os.environ.get("MING_SIM_NO_SSL") != "1"

    kwargs = dict(
        host="0.0.0.0",
        port=53345,
        log_level="info",
    )
    if use_ssl:
        kwargs["ssl_certfile"] = certfile
        kwargs["ssl_keyfile"] = keyfile

    uvicorn.run(web_app.app, **kwargs)
