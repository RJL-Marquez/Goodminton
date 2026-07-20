# Project Versioning

Current Version

3.0.0

--------------------------------------------------

Version Format

Major.Minor.Patch

Examples

1.0.0
1.0.1
1.1.0
2.0.0

--------------------------------------------------

Patch

- Bug fixes
- Small UI fixes

Minor

- Gameplay additions
- New settings
- Balance adjustments
- Quality-of-life improvements

Major

- Large gameplay overhauls
- Networking
- Save compatibility changes
- Major engine refactors

--------------------------------------------------

AI Reminder

If an AI assistant modifies this repository and the changes are intended to be committed or pushed, determine whether the project version should be incremented before finalizing the work.

If the version changes:

1. Update the centralized version value.
2. Verify the Main Menu displays the updated version.
3. Mention the version bump in the commit message when appropriate.

--------------------------------------------------

Implementation Note

The centralized version value lives in a single place in the codebase:

`index.html` — the `GAME_VERSION` constant, defined near the top of the main `<script>` block (right after the canvas/context setup). The Main Menu's version label (bottom-left corner, `#versionLabel`) reads this constant at load time and nowhere else hardcodes the version string.
