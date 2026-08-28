# assets

## hub.jpg

The landing page and the Open Graph / Twitter cards point at `assets/hub.jpg`.
It is not in the repository: it should be a photo of the actual Technic Move
Hub, and the right one to use is a picture of the hub this was developed
against — the one from set 42214.

Drop the file here and it appears; nothing else needs changing. Until then the
page removes the figure itself and the hero spans the full width, so a missing
photo leaves no gap and no broken-image glyph.

Wanted:
- roughly 1160×880 or any similar landscape ratio
- the hub alone, evenly lit, on a plain background
- under ~200 KB, so the page stays quick on a phone tethered in a garage

A photo of a different LEGO part is worse than no photo: the page names a
specific piece of hardware, and illustrating it with a Power Functions battery
box would mislead the people the page is for.

## hljs/

Highlight.js 11.12.0, vendored rather than fetched: the ES core
(`core.min.js`), the JavaScript grammar (`javascript.min.js`) and the project's
BSD-3 licence, 27 KB together. They came from the project's own release
distribution at `cdn-release@11.12.0/build/es/`.

They are here for the same reason the fonts are: no page on this site loads a
script from a third party. The macro editor imports them dynamically on the
first focus in the field, so the landing page never pays for them.

To update, replace both files from the same distribution at the new tag and
re-check the editor. There is no build step and nothing else references them.
