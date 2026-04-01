// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://allagents.dev',
  // Use noop image service to avoid requiring sharp for image optimization
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    starlight({
      title: 'AllAgents',
      disable404Route: true,
      description: 'CLI tool for managing AI coding assistant plugins across multiple clients.',
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/EntityProcess/allagents' },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'docs/getting-started' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'docs/guides' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'docs/reference' },
        },
      ],
    }),
  ],
});
