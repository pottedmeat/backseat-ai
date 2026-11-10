# backseat-ai.dev

The landing page's sources. Netlify serves `site/` as it stands (`netlify.toml` at the repo root; no build step), so what the page doesn't use lives here instead.

- `site/index.html` is the whole page; the look is Roadside.
- `site/og.png` is a screenshot of `og.html` at 1200×630. To regenerate: open `og.html` in a browser at exactly 1200×630 (e.g. Playwright's `page.setViewportSize({ width: 1200, height: 630 })` with `fullPage: false`) and save the screenshot as `site/og.png`.
- `site/apple-touch-icon.png` is `mark-apple.svg` rasterised at 180×180; `site/favicon.svg` is served as drawn.
- `site/stately-light.png` / `site/stately-dark.png` are Stately Studio drawing the lead machine.

## Before launch

The last section's card body is a placeholder: `init`'s output as recorded inside the repo before `backseat-ai` was on npm (it shows `pnpm add backseat-ai@workspace:*` and the old `npm run -s drive --` gate line). Once the package is published, run `npx backseat-ai init my-agent --starter` in an empty directory outside the repo and replace the card's `<pre>` with what it prints, the package manager's own output cut to a `…` line.
