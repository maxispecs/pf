import type { NextConfig } from 'next'
import nextra from 'nextra'

const withNextra = nextra({})

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
}

export default withNextra(nextConfig)
