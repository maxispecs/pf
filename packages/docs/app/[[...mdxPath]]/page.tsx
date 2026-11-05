import { notFound } from 'next/navigation'
import { generateStaticParamsFor, importPage } from 'nextra/pages'
import type { ComponentType } from 'react'
import { useMDXComponents as getMDXComponents } from '../../mdx-components'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

/** Paths with no MDX file 404 up front, so Nextra never logs a load error for stray requests. */
export const dynamicParams = false

type PageProps = { params: Promise<{ mdxPath?: string[] }> }

/** `importPage` throws for a path with no MDX file; that is a 404, not a server error. */
async function loadPage(mdxPath: string[] | undefined) {
  try {
    return await importPage(mdxPath)
  } catch {
    notFound()
  }
}

export async function generateMetadata(props: PageProps) {
  const { metadata } = await loadPage((await props.params).mdxPath)
  return metadata
}

const Wrapper = getMDXComponents().wrapper as ComponentType<Record<string, unknown>>

export default async function Page(props: PageProps) {
  const params = await props.params
  const { default: MDXContent, toc, metadata, sourceCode } = await loadPage(params.mdxPath)
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  )
}
