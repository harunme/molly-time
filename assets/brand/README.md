# MollyTime logo assets

The approved mark is a filled, rounded lowercase m with a detached five-petal flower. Both use Jasmine yellow `#F8DE7E`. The icon background is jasmine white `#FAFAF4`; the outlined Nunito ExtraBold wordmark uses warm ink `#3F3A32`. The spelling is MollyTime, with M and T capitalised.

## Sources and generation

The canonical sources are `mollytime-flower/source/symbol.svg` and `mollytime-flower/source/wordmark.svg`. The former is the approved silhouette; the latter contains nine outlined letters and needs no installed font to display.

Run from the repository root:

```sh
node tools/generate-brand-assets.mjs
```

The generator rebuilds the logo kit, publishes all SVG variants to this directory and to each active web app’s `public/brand/`, regenerates favicon/ICO/PWA icons, and emits equivalent Android filled vector paths and PNG fallbacks. Android cannot use SVG directly as a launcher icon. The adaptive foreground stays inside its safe circle; the full background remains jasmine white.

## Application files

- `mollytime-mark.svg`: yellow symbol with transparent background.
- `mollytime-icon.svg`: yellow symbol on a jasmine-white square.
- `mollytime-horizontal.svg`: yellow symbol + warm-ink wordmark.
- `mollytime-horizontal-on-dark.svg`: yellow symbol + jasmine-white wordmark.
- `mollytime-wordmark.svg` / `mollytime-wordmark-on-dark.svg`: text-only artwork for light / dark surfaces.
- `mollytime-stacked.svg`: vertical lockup.
- `mollytime-banner.svg`: 1280 × 720 TV launcher banner, including the wordmark.
- `mollytime-*-primary.svg`, `*-ink.svg`, `*-jasmine.svg`, `*-black.svg`, `*-white.svg`, `*-ivory.svg`: colour and monochrome exports.

Website, parent app and TV web UI consume the same generated assets. The current native client is `apps/tv/client`; the old `apps/tv/app` fork is retained as historical reference and is not a build target.

The parent app’s PWA manifest retains `/manage/` identity, scope and start URL. Its existing icon URLs are refreshed in place. Browser theme and launcher background use jasmine white.

The complete design kit, palette tokens and usage guide are in `mollytime-flower/`. The website, parent desktop/mobile UI and TV frontend import `mollytime-flower/palette.css` as their shared brand-colour source. The parent/site light background is jasmine white; TV preserves a warm dark cinema background with the same jasmine-yellow controls and focus states. Error/success colours retain their semantic roles.
