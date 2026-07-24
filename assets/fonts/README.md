# Bundled web fonts

These `.woff2` files are bundled so the extension's options page and popup never
reach out to Google's font CDN (`fonts.googleapis.com` / `fonts.gstatic.com`).
The build copies this directory to `dist/fonts/` (see `ensureStaticFiles()` in
`esbuild.config.mjs`); `src/options/styles.css` and `src/popup/styles.css`
declare the `@font-face` rules with `url('fonts/…')`.

## Provenance

Downloaded 2026-07-17 from **google-webfonts-helper**
(<https://gwfh.mranftl.com/fonts>), one subset per download so each file carries
a single subset (the `unicode-range` split lives in the stylesheets). The gwfh
"version" is the upstream Google Fonts revision stamp.

| Family | gwfh id | Version | Upstream updated | Subsets bundled | Weights |
|---|---|---|---|---|---|
| Hanken Grotesk | `hanken-grotesk` | v12 | 2025-09-02 | latin | 400, 500, 600, 700 |
| Source Serif 4 | `source-serif-4` | v14 | 2025-09-11 | latin, cyrillic | 600 |
| IBM Plex Mono | `ibm-plex-mono` | v20 | 2025-09-16 | latin, cyrillic | 400, 500, 600 |

Files (12):

```
hanken-grotesk-latin-400.woff2   hanken-grotesk-latin-500.woff2
hanken-grotesk-latin-600.woff2   hanken-grotesk-latin-700.woff2
source-serif-4-latin-600.woff2   source-serif-4-cyrillic-600.woff2
ibm-plex-mono-latin-400.woff2    ibm-plex-mono-latin-500.woff2    ibm-plex-mono-latin-600.woff2
ibm-plex-mono-cyrillic-400.woff2 ibm-plex-mono-cyrillic-500.woff2 ibm-plex-mono-cyrillic-600.woff2
```

Hanken Grotesk has **no Cyrillic subset** upstream; that is intentional — see
the Task 11 decision entry in `docs/decisions.md`. Cyrillic body copy renders in
the system sans (`-apple-system` / Segoe UI), with Hanken carrying Latin
glossary terms and figures.

## License — all three families are SIL Open Font License 1.1

<https://openfontlicense.org> · <https://scripts.sil.org/OFL>

- **Hanken Grotesk** — Copyright 2021 The Hanken Grotesk Project Authors
  (<https://github.com/hanken-design/Hanken-Grotesk>).
- **Source Serif 4** — Copyright 2014–2023 Adobe (<https://www.adobe.com/>),
  with Reserved Font Name "Source". Source is a trademark of Adobe in the
  United States and/or other countries.
- **IBM Plex Mono** — Copyright © 2017 IBM Corp., with Reserved Font Name
  "Plex" (<https://github.com/IBM/plex>).

The OFL permits bundling and redistribution with software; it forbids selling
the fonts on their own and requires this copyright + license notice to travel
with them.

## Regenerating

Re-download from gwfh (one subset per request keeps files single-subset), then
rename `<id>-v<NN>-<subset>-regular.woff2` → `<id>-<subset>-400.woff2` and strip
the `-v<NN>` stamp from the rest. Example:

```
curl -sSL "https://gwfh.mranftl.com/api/fonts/ibm-plex-mono?download=zip&subsets=cyrillic&variants=regular,500,600&formats=woff2" -o plex-cyr.zip
```

`tests/local-fonts.test.ts` asserts each file exists and begins with the WOFF2
magic (`wOF2`).
