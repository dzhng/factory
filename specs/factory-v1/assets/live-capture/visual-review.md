# Fixture-report visual acceptance

Target: the fixture report must remain readable at desktop and mobile widths
and distinguish fixture-derived behavior from actual authenticated callback
authority. It does not display a live-capture pass or release certification.

The real generated report was captured in Chromium at 1440×900 and 390×900.
The [complete capture set](visual/) retains before/after full pages, matching
lede crops, and enlarged mobile table-access crops. Both candidates differ
from their baselines. Desktop SHA-256 changed from
`2690b6a2b8eff36df537b8c34f84876ca45b01bed7c41167939aa7b24654a07b`
to `d4ffac6fb64ec0764f676bc31eab9f051cfb33ef2079173acf0210a03efd9798`;
mobile changed from
`dc0f120f995084468997b62883dec602f972b62d3a163aaa395a237a3d6761db`
to `a4d5f92b390ee183902d23ac379f3a9ee8d2fa552e024584cf3289ce2c37a56c`.

The baseline mobile page overflowed horizontally. The candidate keeps the
document within its viewport and confines wide donor-table content to its own
horizontal scroller. Full-page dimensions consequently differ; this is not a
pixel-parity claim. The matching lede crops isolate the authority-copy change.

The first fresh visual critique found that hidden table columns had no visible
access cue. The candidate now says “Scroll horizontally to read all table
columns.” A second fresh review of the complete set found no remaining visible
defects: cards, lede, desktop table, and the mobile instruction remain readable.

Browser interaction separately set the mobile table to its right edge. Its
scroll offset was 208 CSS pixels, and the complete **Reason** header was inside
the scroll frame. The [enlarged right-edge capture](visual/after-table-right-390.png)
shows the instruction with readable Behavior and Reason columns. All columns
are reachable; they are not claimed to be visible simultaneously on mobile.

Verdict: **accepted** after the access-cue correction and actual scroll check.
These screenshots certify report presentation only, not provider availability.
