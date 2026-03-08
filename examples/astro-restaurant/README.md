# Schnitzel Fri3nds — A3lix Example

> A German-Canadian restaurant one-pager built with Astro, demonstrating how A3lix lets a non-technical owner update their website by texting a Telegram bot.

---

## What this example shows

A real-world scenario: Felix and Marco run a schnitzel restaurant in Toronto. They want to update their weekly specials, change menu prices, and rewrite their story — without touching code or logging into a CMS. They just text their Telegram bot.

All content lives in `src/content/` as plain JSON and Markdown files. A3lix reads those files, makes the requested changes on a preview branch, and sends back a live preview URL for approval before anything goes to `main`.

---

## Design

Inspired by [Florporto](https://florporto.com/) and [Angel Oak Smokehouse](https://www.angeloaksmokehouse.com/):

- **Palette**: deep charcoal hero, warm cream content sections, amber/gold accents
- **Typography**: Playfair Display (editorial serif headings) + DM Sans (clean body)
- **Layout**: full-viewport dark hero with vertical side labels, split about section, row-based specials board
- **No framework**: pure CSS custom properties, no Tailwind or CSS-in-JS required

---

## Content files (what A3lix edits)

| File | What it controls |
|------|-----------------|
| `src/content/hero.json` | Headline, tagline, subtext, CTA label, badge text |
| `src/content/menu.json` | All menu categories, dish names, descriptions, prices |
| `src/content/specials.json` | Weekly specials — day, name, description, price, active flag |
| `src/content/about.md` | Restaurant story (Markdown, first `# Heading` becomes the section title) |

---

## Demo Telegram requests to try

Copy-paste these to your A3lix bot to test live editing:

```
Change the hero tagline to "crispy. golden. freundschaft."
```
```
Add a new weekly special for Sunday: Sonntagsbraten — slow-braised pork belly with dark beer gravy for $32
```
```
Update the Jägerschnitzel price to $27
```
```
Add a new drink: Radler — half lager, half lemon soda, $8
```
```
Change the about story to mention we opened our second location in Kitchener
```

---

## Getting started

### 1. Fork / clone this example

```bash
git clone https://github.com/a3lix/a3lix.git
cd a3lix/examples/astro-restaurant
npm install
```

### 2. Run locally

```bash
npm run dev
# → http://localhost:4321
```

### 3. Deploy to Cloudflare Pages

Connect this repo to Cloudflare Pages with these settings:

- **Framework preset**: Astro
- **Build command**: `npm run build`
- **Build output directory**: `dist`
- **Root directory**: `examples/astro-restaurant`

### 4. Set up A3lix

Copy `agent.json.example` → `agent.json` and fill in your values, then run:

```bash
npx a3lix@latest init
```

---

## Project structure

```
examples/astro-restaurant/
├── astro.config.mjs
├── package.json
├── agent.json.example      ← copy to agent.json and fill in your values
├── src/
│   ├── content/            ← A3lix edits files in here
│   │   ├── hero.json
│   │   ├── menu.json
│   │   ├── specials.json
│   │   └── about.md
│   └── pages/
│       └── index.astro     ← single page, reads from src/content/
└── public/
```
