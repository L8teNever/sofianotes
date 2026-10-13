"""PDF-Export: nur ausgewaehlte Notizbuch-Seiten."""
from app import goodnotes_export


def _count_pages(pdf: bytes) -> int:
    return pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page ") + pdf.count(b"/Type /Page>")


def _nb():
    return {"pages": [{"id": "a", "paper": "graph"}, {"id": "b", "paper": "lines"}, {"id": "c", "paper": "dots"}]}


def test_all_pages_without_filter():
    pdf = goodnotes_export.build_board_pdf({"notebook": _nb()}, [])
    assert _count_pages(pdf) == 3


def test_only_selected_pages():
    pdf = goodnotes_export.build_board_pdf({"notebook": _nb()}, [], {"a", "c"})
    assert _count_pages(pdf) == 2
    pdf = goodnotes_export.build_board_pdf({"notebook": _nb()}, [], {"b"})
    assert _count_pages(pdf) == 1


def test_missing_image_gets_placeholder():
    # Bilddatei fehlt auf dem Server: Platzhalter statt leerer Stelle
    st = {
        "tool": "image",
        "points": [{"x": 100, "y": 100, "p": 1}, {"x": 400, "y": 300, "p": 1}],
        "extra": {"mediaId": "00000000-0000-4000-8000-000000000000"},
    }
    pdf = goodnotes_export.build_board_pdf({"notebook": {"pages": [{"id": "a", "paper": "blank"}]}}, [st])
    assert b"Helvetica" in pdf
