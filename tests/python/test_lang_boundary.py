#!/usr/bin/env python3
"""Mechanical enforcement of the language boundary in plugins/silex-forge/scripts/.

The rule
--------
Everything under plugins/silex-forge/scripts/ is operator-facing tooling and
must be English-only -- strings, comments and docstrings alike. Three files are
French *by design* and are allowlisted below: they render French product content
for humans, not CLI output for the operator.

The rule is uniform (no comment or docstring exemption) on purpose: it keeps
this checker trivial and the allowlist minimal. A mixed rule would need to
tokenize shell, Python and JavaScript comments correctly to decide what is
exempt, which is exactly the kind of ambiguity that let the bug below through.

Why it exists
-------------
The convention used to be enforced by human vigilance only. During one
translation pass six parallel agents each hand-translated their own file, and
one line survived anyway -- publish.sh's `die "ARTIFACTS_ROOT vide"`, an
operator-facing failure message. Nothing mechanical could catch it: the repo
already lints its bash-3.2 portability convention (tests/shell/test_bash32_lint.sh)
but had no equivalent for language. This test is that equivalent.

Why it lives in the Python tier
-------------------------------
This check needs reliable Unicode matching, and portable shell cannot do it:
`grep -P` does not exist on macOS (the bash-3.2 floor this repo targets), and
`grep -E` character classes over multi-byte accented letters are not dependable
across BSD and GNU grep. Python's `re` is the same everywhere, so the check goes
here rather than next to the shell lints.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "plugins" / "silex-forge" / "scripts"

EXTENSIONS = ("*.sh", "*.py", "*.js")

# French by design -- these render French content for humans, not operator CLI output.
ALLOWLIST = frozenset(
    {
        "gen-index.py",  # renders the forge index site UI, read by French-speaking clients
        "hub-index.py",  # writes a Markdown note into the silex-hub vault (French notes)
        "share-bar.js",  # the team share toolbar rendered on /a/<slug>/
    }
)

# Both cases, spelled out rather than relying on a Unicode property so the
# intent is auditable and the set stays deliberately French.
ACCENTS = "àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ"

# Capture the whole word around the accent: reporting `précédente` tells the
# operator what to translate, where a bare `é` does not.
ACCENT_WORD = re.compile(
    "[0-9A-Za-z_]*[" + ACCENTS + "][0-9A-Za-z_" + ACCENTS + "]*"
)

# Unambiguously French, plausible in this codebase, and -- critically -- not
# valid English and not identifiers used here.
#
# The FR/EN homograph trap is the one that bites: a word being French is not
# enough, it must not also be English, or this lint fails CI on correct code
# and blames "French" for it. `absent`, `index`, `public`, `share`, `private`,
# `token`, `date`, `local` and `site` are legitimate English or code here
# (forge-doctor.sh prints "absent (publish KO)"; every .sh uses the `local`
# keyword). `impossible` and `dossier` are English too -- `die "impossible
# state: ..."` is idiomatic error text -- so they are excluded despite being
# French words; French sentences using them almost always carry another marker
# ("impossible de lire le fichier" trips `fichier`). test_known_english_strings
# pins these exclusions.
#
# Unaccented spellings are included so transliterated French ("echec", "deja")
# is caught by this rule even when the accent rule cannot see it.
#
# Connectives matter as much as nouns: `die "usage: --share <slug> ou ..."` was
# French that no noun in this list could see. `pour` and `sans` are excluded
# from that group for the homograph reason above -- `pour` is an English verb
# and `\bsans\b` matches the `sans` in a CSS `sans-serif` declaration.
FRENCH_WORDS = (
    "aucun",
    "aucune",
    "avec",
    "bouton",
    "chemin",
    "dans",
    "deja",
    "echec",
    "equipe",
    "fichier",
    "genere",
    "generer",
    "inconnu",
    "introuvable",
    "lien",
    "manquant",
    "manquante",
    "ou",
    "partage",
    "partagee",
    "prive",
    "privee",
    "publique",
    "puis",
    "selon",
    "veuillez",
    "vide",
    "voir",
)

FRENCH_WORD = re.compile(r"\b(?:" + "|".join(FRENCH_WORDS) + r")\b", re.IGNORECASE)

RULES = (
    (ACCENT_WORD, "French accented letters"),
    (FRENCH_WORD, "French word"),
)


def scanned_files() -> list[Path]:
    """Every script the boundary applies to, allowlisted ones included, sorted."""
    found = set()
    for pattern in EXTENSIONS:
        for path in SCRIPTS.rglob(pattern):
            if "__pycache__" in path.parts:
                continue
            found.add(path)
    return sorted(found)


def violations() -> list[str]:
    """`<relpath>:<lineno>: <reason>: <matched text>` for every offending line."""
    found = []
    for path in scanned_files():
        if path.name in ALLOWLIST:
            continue
        rel = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), 1):
            for pattern, reason in RULES:
                hits = []
                for found_text in (m.group(0) for m in pattern.finditer(line)):
                    if found_text not in hits:
                        hits.append(found_text)
                if hits:
                    found.append(
                        "{0}:{1}: {2}: {3}".format(
                            rel, lineno, reason, ", ".join(hits)
                        )
                    )
    return found


class LanguageBoundaryTests(unittest.TestCase):
    def test_non_allowlisted_scripts_are_english_only(self) -> None:
        found = violations()
        if found:
            self.fail(
                "French in operator-facing scripts (translate, or allowlist the "
                "file in tests/python/test_lang_boundary.py if it is French by "
                "design):\n" + "\n".join(found)
            )

    def test_allowlisted_files_still_exist(self) -> None:
        """A renamed allowlist entry must break loudly, not disable the rule.

        The allowlist is keyed by basename. If gen-index.py were renamed, its
        entry would go dead: the new name would be scanned as English-only and
        start failing for its (intentional) French, while nobody would be
        checking the exemption is still warranted. Either way the rule would
        drift away from the convention silently, so pin the names here.
        """
        present = set(path.name for path in scanned_files())
        self.assertEqual(sorted(ALLOWLIST - present), [])

    def test_scan_actually_finds_the_scripts(self) -> None:
        """Guard against the glob silently matching nothing (moved directory)."""
        self.assertTrue(SCRIPTS.is_dir(), "missing {0}".format(SCRIPTS))
        self.assertGreater(len(scanned_files()), len(ALLOWLIST))

    def test_known_english_strings_are_not_flagged(self) -> None:
        """Correct English operator output must never trip this lint.

        A false positive here is worse than a miss: it blocks correct work and
        blames "French" for it, which is how a lint earns itself a bypass.
        Every line below is idiomatic English error text whose words are also
        French, or repo identifiers that merely look French. They pin the
        homograph exclusions documented above FRENCH_WORDS -- re-adding
        `impossible`, `dossier`, `pour` or `sans` to that tuple breaks this
        test.
        """
        english = (
            'die "impossible state: STAGE set without WORK"',
            'die "cannot read the dossier at $dest"',
            'print("  cf token : absent (publish KO)")',
            '  local project="$PAGES_PROJECT"',
            'die "no such file: $input"',
            'info "share link minted for private slug"',
            'echo "index rebuilt from the public catalogue"',
            'info "pour the resolved config into the deploy tree"',
            'echo "  font-family: system-ui, sans-serif;"',
        )
        flagged = []
        for line in english:
            for pattern, reason in RULES:
                hits = [m.group(0) for m in pattern.finditer(line)]
                if hits:
                    flagged.append("{0}: {1}: {2}".format(reason, ", ".join(hits), line))
        self.assertEqual([], flagged, "false positive on correct English:\n" + "\n".join(flagged))


if __name__ == "__main__":
    unittest.main()
