"""Renders a generated deck end to end with the real LibreOffice and Poppler."""

import shutil
from pathlib import Path

import pytest
from pptx import Presentation
from pptx.util import Inches

from render import read_pptx_meta, render_file

needs_tools = pytest.mark.skipif(
    not (shutil.which("soffice") and shutil.which("pdftoppm") and shutil.which("pdfinfo")),
    reason="LibreOffice and Poppler are required",
)


def make_deck(path: Path) -> None:
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    for i, (title, notes) in enumerate(
        [("Welcome", "สวัสดีครับ\nThank the crew"), ("Agenda", ""), ("Questions", "Hand back to the moderator")]
    ):
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = title
        slide.placeholders[1].text = f"Point {i + 1}"
        if notes:
            slide.notes_slide.notes_text_frame.text = notes
        if i == 1:
            slide._element.set("show", "0")  # hidden slide
    prs.save(str(path))


def test_reads_notes_titles_and_hidden(tmp_path: Path) -> None:
    deck = tmp_path / "talk.pptx"
    make_deck(deck)
    meta, aspect = read_pptx_meta(deck)
    assert [m["title"] for m in meta] == ["Welcome", "Agenda", "Questions"]
    assert meta[0]["notes"] == "สวัสดีครับ\nThank the crew"
    assert meta[1]["notes"] is None
    assert [m["hidden"] for m in meta] == [False, True, False]
    assert aspect == pytest.approx(16 / 9, rel=1e-3)


@needs_tools
def test_renders_every_slide_including_hidden(tmp_path: Path) -> None:
    deck = tmp_path / "talk.pptx"
    make_deck(deck)
    work = tmp_path / "work"
    work.mkdir()
    progress = []
    result = render_file(deck, work, width=640, on_progress=lambda d, t: progress.append((d, t)))
    assert len(result.slides) == 3, "hidden slides must be rendered so numbering matches PowerPoint"
    assert progress[-1] == (3, 3)
    for s in result.slides:
        assert s.image is not None and s.image.exists() and s.image.stat().st_size > 1000
    assert result.slides[0].notes.startswith("สวัสดีครับ")
    assert result.slides[1].hidden is True
    assert result.aspect == pytest.approx(16 / 9, rel=1e-3)


@needs_tools
def test_renders_pdf_directly(tmp_path: Path) -> None:
    deck = tmp_path / "talk.pptx"
    make_deck(deck)
    work = tmp_path / "work"
    work.mkdir()
    from render import to_pdf

    pdf = to_pdf(deck, work)
    work2 = tmp_path / "work2"
    work2.mkdir()
    result = render_file(pdf, work2, width=320)
    assert len(result.slides) == 3
    assert result.slides[0].notes is None
