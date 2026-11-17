import type { Metadata } from 'next'
import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import type { ReactNode } from 'react'
import 'nextra-theme-docs/style.css'

export const metadata: Metadata = {
  title: { default: 'pf documentation', template: '%s - pf' },
  description: 'pf (pulpfixer): one developer CLI for any repo. Commands, agent, plugins and host mode.',
}

const logo = (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/logo.png" alt="pulpfixer" width={28} height={28} style={{ borderRadius: 6 }} />
    <strong>pf</strong>
  </span>
)

const navbar = <Navbar logo={logo} />
const footer = <Footer>pf (pulpfixer) documentation.</Footer>

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout navbar={navbar} pageMap={await getPageMap()} footer={footer} sidebar={{ defaultMenuCollapseLevel: 1 }}>
          {children}
        </Layout>
      </body>
    </html>
  )
}
