"""What language a card is in, and when we are entitled to say.

The bug this exists for: a Japanese ST01-001 Luffy leader was reported as
English and priced as the English printing. The recogniser reads Latin
script, so a Japanese card does not come back as bad Japanese — it comes back
as almost nothing, and the little that survives is Latin. `latin > 0` was
enough to call it English, and the app then told the member "Rules text reads
as English" about rules text it had never read.

So the test is not "can we read Japanese". It is "do we refuse to claim
English when we have read almost nothing".
"""

from app.pipeline.identify import decide_language


# Verbatim from the vision service on 13 September 2026, given the Japanese
# ST01-001 leader: seven fragments off the logo and the frame, every kana
# dropped — including the kana either side of the ·D· it did catch.
REAL_JP_CARD_OCR = "ONE PIECE 60 0009 C GAM ·D· 294/"


def test_a_japanese_card_we_could_not_read_is_not_english():
    language, japanese = decide_language(REAL_JP_CARD_OCR)
    assert language == "unknown", "claimed English off seven Latin fragments"
    assert japanese is False, "we did not see Japanese; we saw nothing"


def test_japanese_rules_text_is_japanese():
    language, japanese = decide_language("モンキー・D・ルフィ ターン1回 攻撃メイン 1枚までを付与する")
    assert language == "ja"
    assert japanese is True


def test_english_rules_text_is_english():
    language, japanese = decide_language(
        "On Play DON!! -10: Place all of your DON!! cards at the bottom of your deck"
    )
    assert language == "en"
    assert japanese is False


def test_decorative_kanji_does_not_make_a_card_japanese():
    # The regression a previous fix was written for: One Piece prints 特
    # ("SPECIAL") and 商 on ENGLISH cards, and matching any CJK at all once
    # declared an English Stussy Japanese — pricing it against a different
    # card. Kana needs two, kanji needs six.
    language, japanese = decide_language(
        "Stussy SP OP07-085 SR 特 商 Straw Hat Crew Character 5000 Counter"
    )
    assert language == "en"
    assert japanese is False


def test_nothing_read_at_all_is_unknown():
    assert decide_language("") == ("unknown", False)
    assert decide_language("   ") == ("unknown", False)


def test_the_floor_is_about_quantity_not_content():
    # Just under and just over. A card whose text barely registers is not a
    # claim about language in either direction.
    assert decide_language("ONE PIECE 60 C")[0] == "unknown"
    assert decide_language("Monkey D Luffy Straw Hat Crew Leader")[0] == "en"
