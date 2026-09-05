"""Seed the database with sample data so the UI can be explored
before Telegram is connected. Run: python -m box demo"""
from datetime import datetime, timedelta

from . import db
from .config import MEDIA_DIR, ensure_dirs

PALETTES = [
    ("#2b3a55", "#ce7777"), ("#1a3c40", "#417d7a"), ("#3d2c8d", "#916bbf"),
    ("#553939", "#a77979"), ("#1f4068", "#206a5d"), ("#5c3d2e", "#b85c38"),
    ("#2c3639", "#a27b5c"), ("#212121", "#616161"), ("#144272", "#205295"),
    ("#3f0071", "#610094"),
]


def placeholder(idx, w, h):
    a, b = PALETTES[idx % len(PALETTES)]
    name = f"demo_{idx}.svg"
    (MEDIA_DIR / name).write_text(f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient></defs>
<rect width="{w}" height="{h}" fill="url(#g)"/>
<circle cx="{w * 0.8:.0f}" cy="{h * 0.25:.0f}" r="{min(w, h) * 0.35:.0f}" fill="#ffffff" opacity="0.06"/>
<circle cx="{w * 0.15:.0f}" cy="{h * 0.8:.0f}" r="{min(w, h) * 0.25:.0f}" fill="#000000" opacity="0.15"/>
</svg>""")
    return name


def main():
    ensure_dirs()
    db.init_db()
    if db.counts()["all"] > 0:
        print("Database already has items; demo data not added.")
        return

    archive = db.find_or_create_collection("Archive")
    design = db.find_or_create_collection("Design")
    arch = db.find_or_create_collection("Modern Architecture")
    ui = db.find_or_create_collection("UI design", design)
    ux = db.find_or_create_collection("UX Research", design)
    tobuy = db.find_or_create_collection("To-Buy")
    kitchen = db.find_or_create_collection("Kitchen", tobuy)

    now = datetime.now().astimezone()

    def ts(days, hours=0):
        return (now - timedelta(days=days, hours=hours)).isoformat()

    items = [
        dict(kind="article", title="The Slow Web: why calm software wins",
             site_name="Medium", url="https://medium.com/example/slow-web",
             collection_id=None, tg_date=ts(0, 1), w=640, h=760),
        dict(kind="article", title="Yes, I'm judging your creative stuff",
             site_name="Medium", url="https://medium.com/example/judging",
             collection_id=design, tg_date=ts(0, 2), w=640, h=340),
        dict(kind="video", title="7 Reasons No One Is Hiring You as a Freelance Writer",
             site_name="YouTube", url="https://youtube.com/watch?v=example1",
             collection_id=archive, tg_date=ts(0, 3), w=480, h=560),
        dict(kind="article", title="I stopped doing wireframes, this is what happened next",
             site_name="Medium", url="https://medium.com/example/wireframes",
             collection_id=ui, tg_date=ts(0, 4), w=480, h=560),
        dict(kind="image", title="Concrete house in the pines",
             site_name=None, url=None, collection_id=arch, tg_date=ts(1, 2), w=640, h=420),
        dict(kind="article", title="Field notes: interviewing users who hate your product",
             site_name="UX Collective", url="https://uxdesign.cc/example",
             collection_id=ux, tg_date=ts(1, 4), w=640, h=380),
        dict(kind="video", title="Mountain timelapse — 4K nature relaxation",
             site_name="YouTube", url="https://youtube.com/watch?v=example2",
             collection_id=None, tg_date=ts(1, 6), w=640, h=300),
        dict(kind="article", title="Japanese steel scissors, hand-forged since 1923",
             site_name="Kaufmann Mercantile", url="https://example.com/scissors",
             collection_id=kitchen, tg_date=ts(2, 1), w=520, h=520),
        dict(kind="file", title="Annual-Design-Trends-2026.pdf", file_name="Annual-Design-Trends-2026.pdf",
             site_name=None, url=None, collection_id=design, tg_date=ts(2, 5), w=0, h=0),
        dict(kind="note", title=None, url=None, site_name=None, collection_id=None,
             text="Idea: weekly digest email of everything saved to Box, grouped by collection.",
             tg_date=ts(3, 2), w=0, h=0),
        dict(kind="article", title="Brutalism, softened: the new wave of concrete homes",
             site_name="Dezeen", url="https://dezeen.com/example",
             collection_id=arch, tg_date=ts(3, 4), w=640, h=430),
        dict(kind="image", title="Palette study — dusk tones",
             site_name=None, url=None, collection_id=ui, tg_date=ts(4, 1), w=560, h=680),
    ]

    for i, it in enumerate(items):
        w, h = it.pop("w"), it.pop("h")
        fields = dict(it)
        if w:
            fields["image_path"] = placeholder(i, w, h)
        db.create_item(fields)
    print(f"Seeded {len(items)} demo items and 7 collections.")
    print("Remove them later with: rm data/box.db data/media/demo_*.svg && restart")


if __name__ == "__main__":
    main()
