import type { NextConfig } from 'next'
import nextra from 'nextra'

const withNextra = nextra({})

// DOCS_EXPORT=1 builds a static site into out/ (AWS Amplify, see /amplify.yml).
// Without it the site runs as a normal Next server (pf docs, pnpm docs:dev).
const staticExport = process.env.DOCS_EXPORT === '1'

const nextConfig: NextConfig = {
  ...(staticExport ? { output: 'export' as const, trailingSlash: true, images: { unoptimized: true } } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
}

export default withNextra(nextConfig)
