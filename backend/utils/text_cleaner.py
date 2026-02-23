"""
Text cleaner utilities for filtering pseudo-field tokens from foreshadowing text
and extracting keywords for fallback thread resolution matching.
"""

import re

# Configurable blocklist of pseudo-field words commonly found in blueprint plans
DEFAULT_BLOCKLIST: set[str] = {
    "id", "description", "item", "target",
    "source_chapter", "potential_use", "type", "goal",
}

# Chinese stopwords for keyword extraction
KEYWORD_STOPWORDS: set[str] = {
    "的", "了", "和", "与", "在", "是", "有", "不", "这", "那",
    "也", "都", "就", "而", "但", "又", "或", "被", "把", "对",
    "从", "向", "为", "以", "到", "让", "给", "用", "将", "会",
}

MIN_KEYWORD_LENGTH: int = 2

# Pattern to split tokens: matches sequences of word characters (latin, digits,
# underscore) or individual CJK characters.
_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]")


def is_pseudo_field_line(line: str, blocklist: set[str] | None = None) -> bool:
    """
    Determine if a line consists primarily of blocklisted/pseudo-field words.

    Tokenizes the line by extracting word-like tokens (latin words, digits,
    CJK characters), then checks if blocklisted tokens make up more than
    50% of total tokens.

    Args:
        line: A single line of text to evaluate.
        blocklist: Optional custom blocklist. Defaults to DEFAULT_BLOCKLIST.

    Returns:
        True if blocklisted tokens ratio > 50%, False otherwise.
    """
    if blocklist is None:
        blocklist = DEFAULT_BLOCKLIST

    tokens = _TOKEN_RE.findall(line)
    if not tokens:
        return False

    blocked_count = sum(1 for t in tokens if t.lower() in blocklist)
    return blocked_count / len(tokens) > 0.5


def clean_foreshadowing_text(text: str, blocklist: set[str] | None = None) -> str:
    """
    Filter lines from foreshadowing text that consist primarily of blocklisted tokens.

    Processes each line through ``is_pseudo_field_line`` and removes lines where
    the blocklisted token ratio exceeds 50%.

    Args:
        text: The raw foreshadowing text (may be multi-line).
        blocklist: Optional custom blocklist. Defaults to DEFAULT_BLOCKLIST.

    Returns:
        Cleaned text with pseudo-field lines removed, remaining lines joined
        by newline.
    """
    if not text:
        return ""

    if blocklist is None:
        blocklist = DEFAULT_BLOCKLIST

    kept_lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            # Preserve blank lines for readability
            kept_lines.append(line)
            continue
        if not is_pseudo_field_line(stripped, blocklist):
            kept_lines.append(line)

    return "\n".join(kept_lines)


def extract_keywords(text: str, min_length: int = MIN_KEYWORD_LENGTH) -> list[str]:
    """
    Extract keywords from text with minimum length threshold and stopword removal.

    Used for fallback thread resolution matching in foreshadowing recovery.

    Args:
        text: Input text to extract keywords from.
        min_length: Minimum character length for a keyword (default 2).

    Returns:
        List of unique keywords that pass length and stopword filters,
        preserving first-occurrence order.
    """
    if not text:
        return []

    tokens = _TOKEN_RE.findall(text)

    seen: set[str] = set()
    keywords: list[str] = []
    for token in tokens:
        t = token.lower()
        if len(t) < min_length:
            continue
        if t in KEYWORD_STOPWORDS:
            continue
        if t not in seen:
            seen.add(t)
            keywords.append(t)

    return keywords
