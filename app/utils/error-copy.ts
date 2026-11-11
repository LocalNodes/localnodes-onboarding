// The words on the site-wide error page. A missing page gets its own title and
// sentence; every other error gets one calm sentence. Neither shows the status
// code or the server's message: those can name internals, so they stay out of
// the page.
export const ERROR_COPY = {
  notFound: { title: 'Page Not Found', body: 'We couldn\'t find this page.' },
  other: { title: 'Something Went Wrong', body: 'We couldn\'t open this page. Try again, or return to LocalNodes.' },
  home: 'Back to the LocalNodes home page'
} as const

/** The title and sentence for an error's status code: 404 reads as a missing page, anything else as the general one. */
export function errorCopy(statusCode: unknown): { title: string, body: string } {
  return statusCode === 404 ? ERROR_COPY.notFound : ERROR_COPY.other
}
