// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

/**
 * The site is two halves that share one ground.
 *
 *   /       the landing page — hand-written HTML in public/, copied verbatim.
 *           It carries the interactive terminal, which is the showpiece; there
 *           is nothing for a framework to add.
 *   /docs/  the manual — Starlight, for search, per-topic URLs, a right-hand
 *           contents list and prev/next. One file per topic under
 *           src/content/docs/docs/, which is what puts them at /docs/*.
 *
 * Both read the same tokens.css, and the ground toggle writes one localStorage
 * key, so a choice made on either half carries to the other.
 */
export default defineConfig({
  site: 'https://talea-run.web.app',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'talea',
      description:
        'The complete talea manual: install it, build the catalogue, adopt the checkouts you already have, and keep every machine on the same folder structure.',
      logo: { src: './src/assets/sprig.svg', alt: 'talea' },
      favicon: '/favicon.svg',
      social: { github: 'https://github.com/ProjectAJ14/talea' },
      customCss: ['./src/styles/docs.css'],
      // Firebase Analytics, the same module the landing page loads, so the
      // measurement id cannot drift between the two halves.
      head: [
        { tag: 'script', attrs: { type: 'module', src: '/analytics.js?v=1' } },
      ],
      // Expressive Code ships its own syntax themes; these two are the closest
      // neutrals to our grounds, so code does not arrive in a third palette.
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styles: { borderRadius: '0', frames: { shadowColor: 'transparent' } },
      },
      // Starlight's own toggle would fight ours; ours is in the shared nav and
      // writes the key both halves read.
      components: {
        ThemeSelect: './src/components/GroundToggle.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { slug: 'docs' },
            { slug: 'docs/installing' },
            { slug: 'docs/first-machine' },
            { slug: 'docs/every-machine' },
          ],
        },
        {
          label: 'Using it',
          items: [
            { slug: 'docs/every-day' },
            { slug: 'docs/adopting' },
            { slug: 'docs/agents' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'docs/commands' },
            { slug: 'docs/catalogue' },
            { slug: 'docs/auth' },
          ],
        },
        {
          label: 'Going deeper',
          items: [
            { slug: 'docs/how-it-works' },
            { slug: 'docs/safety' },
            { slug: 'docs/troubleshooting' },
            { slug: 'docs/faq' },
          ],
        },
      ],
    }),
  ],
});
