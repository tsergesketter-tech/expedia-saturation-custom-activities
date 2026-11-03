"""Inline the Expedia logo and console screenshot into deck.src.html -> expedia-decisioning-session.html (single shareable file)."""
import base64, pathlib
here = pathlib.Path(__file__).parent
uri = lambda p: "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
html = (here / "deck.src.html").read_text()
html = html.replace("__LOGO__", uri(here.parent / "src/public/expedia-logo.png")).replace("__CONSOLE__", uri(here / "console.png"))
(here / "expedia-decisioning-session.html").write_text(html)
print("wrote", here / "expedia-decisioning-session.html")
