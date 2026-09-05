import sys


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "login":
        from .login import main as f
        f()
    elif cmd == "demo":
        from .demo import main as f
        f()
    elif cmd == "backup":
        from .backup import main as f
        f()
    elif cmd == "run":
        import uvicorn
        from .config import load_config
        cfg = load_config()
        print(f"Box running at http://localhost:{cfg['port']}")
        uvicorn.run("box.server:app", host="127.0.0.1", port=cfg["port"], log_level="warning")
    else:
        print("usage: python -m box [run|login|demo|backup]")
        sys.exit(1)


main()
