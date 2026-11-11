/** Serves a static public/list/* page with the link's token filled into its
 *  form, so the button works without JavaScript. GETs never act on the
 *  token themselves: mail scanners open every link in a message. */
export async function pageWithToken(env, request, pagePath, token) {
  const page = await env.ASSETS.fetch(new URL(pagePath, request.url));
  return new HTMLRewriter()
    .on('input[name="token"]', {
      element(el) {
        el.setAttribute("value", token); // isToken() already limited it to [A-Za-z0-9_-]
      },
    })
    .transform(
      new Response(page.body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      }),
    );
}
