from app.pipeline.identify import parse_slab


def _t(text, top):
    return {"text": text, "top": top, "score": 0.9, "height": 0.03, "left": 0.1}


def test_detects_psa_slab_label():
    texts = [
        _t("2024 ONE PIECE", 0.03),
        _t("MONKEY D. LUFFY", 0.06),
        _t("500 YEARS IN THE FUTURE", 0.09),
        _t("GEM MT", 0.04),
        _t("10", 0.05),
        _t("96811063", 0.08),
        _t("PSA", 0.10),
        _t("Monkey.D.Luffy", 0.75),
    ]
    slab = parse_slab(texts)
    assert slab is not None
    assert slab["company"] == "PSA"
    assert "GEM MT" in slab["gradeText"]
    assert "10" in slab["gradeText"]
    assert slab["certNumber"] == "96811063"


def test_no_slab_on_plain_card():
    texts = [
        _t("Charizard", 0.05),
        _t("HP 120", 0.06),
        _t("Fire Spin", 0.5),
        _t("4/102", 0.9),
    ]
    assert parse_slab(texts) is None


def test_detects_beckett_slab_label():
    texts = [
        _t("2006 EX DRAGON FRONTIERS", 0.05),
        _t("#100 CHARIZARD DS HOLO R", 0.07),
        _t("8.5", 0.05),
        _t("NM-MT+", 0.08),
        _t("CENTERING 9.5 CORNERS 8", 0.10),
        _t("0011755115", 0.09),
        _t("BECKETT", 0.12),
    ]
    slab = parse_slab(texts)
    assert slab is not None
    assert slab["company"] == "BGS"
    assert "NM-MT" in slab["gradeText"]
    assert "8.5" in slab["gradeText"]
    assert slab["certNumber"] == "0011755115"


def test_mint_word_alone_is_not_a_slab():
    # card flavor text containing "mint" with no company or cert
    texts = [_t("Mint condition guaranteed", 0.1)]
    assert parse_slab(texts) is None
