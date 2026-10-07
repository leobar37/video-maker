import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';

/**
 * Inline SVG favicon (no external requests): amber play mark on charcoal —
 * the neutral studio glyph shared by the login brand moment.
 */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2317151a'/%3E%3Crect x='.5' y='.5' width='31' height='31' rx='6.5' fill='none' stroke='%23e8a33d' stroke-opacity='.55'/%3E%3Cpath d='M12.5 10.2v11.6l9.4-5.8z' fill='%23e8a33d'/%3E%3C/svg%3E";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: 'Portal de clientes' }],
    links: [{ rel: 'icon', type: 'image/svg+xml', href: FAVICON }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="es">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
