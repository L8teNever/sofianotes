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


def _mixed():
    return [
        {"tool": "pen", "color": "#000000", "size": 4, "points": [{"x": 50, "y": 50, "p": 1}, {"x": 120, "y": 90, "p": 1}], "extra": {}},
        {"tool": "text", "color": "#000000", "size": 22, "points": [{"x": 60, "y": 200, "p": 1, "text": "Hallo Text"}, {"x": 260, "y": 180, "p": 1}, {"x": 60, "y": 210, "p": 1}], "extra": {"box": True}},
    ]


def test_show_only_ink_leaves_out_text():
    nb = {"pages": [{"id": "a", "paper": "blank"}]}
    with_text = goodnotes_export.build_board_pdf({"notebook": nb}, _mixed())
    only_ink = goodnotes_export.build_board_pdf({"notebook": nb}, _mixed(), show={"ink"})
    assert len(only_ink) < len(with_text)
    assert goodnotes_export.filter_kinds(_mixed(), {"text"})[0]["tool"] == "text"


def test_area_export_one_page():
    nb = {"pages": [{"id": "a", "paper": "graph"}, {"id": "b", "paper": "lines"}]}
    pdf = goodnotes_export.build_board_pdf({"notebook": nb}, _mixed(), area=(0, 0, 400, 300), bg=False)
    assert _count_pages(pdf) == 1
    plain = goodnotes_export.build_board_pdf({}, _mixed(), area=(0, 0, 400, 300))
    assert _count_pages(plain) == 1
