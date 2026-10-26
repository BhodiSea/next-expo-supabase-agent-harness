// Starlight route middleware: a TechArticle JSON-LD block per page, built from the same
// validated entry data Starlight renders (title, description, lastUpdated).
import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute
  const { data } = route.entry
  if (data.template === 'splash' || !context.site) return
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: data.title,
    ...(data.description ? { description: data.description } : {}),
    ...(route.lastUpdated ? { dateModified: route.lastUpdated.toISOString() } : {}),
    url: new URL(context.url.pathname, context.site).href,
    isPartOf: { '@type': 'WebSite', name: route.siteTitle, url: new URL(import.meta.env.BASE_URL, context.site).href },
  }
  route.head.push({ tag: 'script', attrs: { type: 'application/ld+json' }, content: JSON.stringify(jsonLd) })
})
