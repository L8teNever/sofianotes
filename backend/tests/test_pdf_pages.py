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
