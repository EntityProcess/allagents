# Plan: Scaffold Landing Page (Inspired by Grepai)

This plan outlines the steps to scaffold a modern, content-focused landing page using the tech stack identified from the Grepai repository.

## Tech Stack
- **Framework:** [Astro](https://astro.build/) (v5+)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **Content:** [MDX](https://mdxjs.com/)
- **Search:** [Pagefind](https://pagefind.app/)
- **Deployment:** GitHub Pages via GitHub Actions

---

## Phase 1: Project Initialization
- [ ] Initialize a new Astro project using the latest version.
- [ ] Install and configure Tailwind CSS integration (`npx astro add tailwind`).
- [ ] Install and configure MDX integration (`npx astro add mdx`).
- [ ] Set up the directory structure:
    - `src/components/`: Reusable UI components.
    - `src/layouts/`: Base HTML layouts.
    - `src/pages/`: Main landing page and sub-pages.
    - `src/content/`: MDX collections for documentation or blog posts.

## Phase 2: Core Layout & Components
- [ ] Create a `BaseLayout.astro` with metadata, Tailwind fonts, and SEO tags.
- [ ] Implement core UI components:
    - **Navbar:** Sticky navigation with links and GitHub icon.
    - **Hero Section:** Large title, description, and Call to Action (CTA).
    - **Features Grid:** Responsive grid showcasing key selling points.
    - **Code Snippet / Demo:** Interactive or static code block using Astro's built-in Shiki support.
    - **Footer:** Links and copyright information.

## Phase 3: Content & Search
- [ ] Define a content collection for "docs" or "guides" in `src/content/config.ts`.
- [ ] Create initial MDX files to test content rendering.
- [ ] Integrate Pagefind for static site search:
    - Configure build script to run `pagefind` after `astro build`.
    - Add a search component to the Navbar.

## Phase 4: Customization & Polishing
- [ ] Configure `astro.config.mjs` with the target `site` URL.
- [ ] Set up light/dark mode support (standard in modern landing pages).
- [ ] Optimize images using Astro's `<Image />` component.

## Phase 5: Deployment
- [ ] Create `.github/workflows/deploy.yml` for automated GitHub Pages deployment.
- [ ] Configure a custom domain:
    - Add `public/CNAME`.
    - Update `site` in `astro.config.mjs`.
- [ ] Run a final production build and verify performance metrics (Lighthouse).
