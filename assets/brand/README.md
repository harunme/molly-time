# MollyTime mark

The logo is a flat white double-arch M on a fresh jasmine-green background. Its shorter
middle stem and rounded ends keep the silhouette readable at small sizes.

- Fresh jasmine green: `#22864B`
- White: `#FFFFFF`
- Stroke: 18 units with round ends; center stem ends at 83, outer stems at 102.
- Source: `mollytime-mark.svg`
- Standalone icon: `mollytime-icon.svg`
- TV launcher banner: `mollytime-banner.svg`

After editing the source vector, run `node tools/generate-brand-assets.mjs` from
the repository root. The script uses the site's installed `sharp` dependency to
generate the Android vector drawables and PNG fallbacks, web favicons and touch icon.
The adaptive foreground fits inside Android's safe circle; its background stays
solid so launcher masks do not clip the M.
The legacy launcher uses a centered 48dp square layer to preserve the mark's
aspect ratio when an installer supplies non-square drawable bounds.

The website, parent app and TV web app serve these SVG files from `public/brand/`.
Their brand components display the same SVG icon beside the MollyTime name.
The Android launcher, banner and adaptive foreground use equivalent vector
drawables, since Android does not accept SVG directly as a launcher resource.
Edit the SVG source and regenerate instead of editing these outputs separately.
