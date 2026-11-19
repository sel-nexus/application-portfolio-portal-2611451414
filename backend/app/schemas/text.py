"""Enforce plain-text inventory and account inputs without changing safe content."""

import re
from html import unescape
from urllib.parse import unquote

MARKUP = re.compile(r"<\s*(?:/?[a-zA-Z]|!|\?)")
TRAVERSAL = re.compile(r"(?:^|[/\\\s])\.\.(?:[/\\]|$)")


def plain_text(value: str) -> str:
    """Reject HTML-like markup and parent-directory path components.

    Args:
        value: A writable inventory or account fact, not a password or search.

    Returns:
        The original content, preserving punctuation, newlines and normal URLs.

    Raises:
        ValueError: If raw or HTML/URL-encoded text contains markup or traversal.

    Notes:
        Decode only for inspection; this is rejection, not HTML sanitization.
        Comparisons such as ``2 < 3`` and technology names such as C++ remain
        valid. Rendering must still use text escaping, and CSV formula safety
        remains the export layer's responsibility.
    """
    inspected = unescape(unquote(value))
    if MARKUP.search(inspected):
        raise ValueError("Enter plain text without HTML or script markup")
    if TRAVERSAL.search(inspected):
        raise ValueError("Text must not contain parent-directory path traversal")
    return value
