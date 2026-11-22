import sys


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "login":
        from .login import main as f
        f()
    elif cmd == "demo":
        from .demo import main as f
        f()
    elif cmd == "bot":
        from .botsetup import main as f
        f()
    elif cmd == "ai-key":
        from .aikey import main as f
        f()
    elif cmd == "backup":
        from .backup import main as f
        f()
    elif cmd == "run":
        import uvicorn
        from .config import load_config
        cfg = load_config()
        print(f"Box running at http://{cfg['host']}:{cfg['port']}")
        uvicorn.run("box.server:app", host=cfg["host"], port=cfg["port"], log_level="warning")
    elif cmd == "token":
        import secrets
        print(secrets.token_urlsafe(32))
    else:
        print("usage: python -m box [run|login|bot|ai-key|demo|backup|token]")
        sys.exit(1)


main()
