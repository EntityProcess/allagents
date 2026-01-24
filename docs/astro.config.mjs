// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://allagents.dev',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    starlight({
      title: 'AllAgents',
      description: 'CLI tool for managing AI coding assistant plugins across multiple clients.',
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      components: {
        Hero: './src/components/Hero.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/EntityProcess/allagents' },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
      ],
    }),
  ],
});
