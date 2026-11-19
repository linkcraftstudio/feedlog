import http from 'node:http'
import dns from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
import { gzipSync } from 'node:zlib'

export const origin = 'http://web-source.fixture.example'
export const facts = ['## Plan limits', '| Pro | 200 |', 'const widget = "<Widget>";', '中文帮助内容', 'FINAL_EVIDENCE_42']
export const article = `<main><h1>Widget installation</h1><p>Install the widget and configure notifications to collect customer feedback. 中文帮助内容</p><h2>Plan limits</h2><table><tr><th>Plan</th><th>Limit</th></tr><tr><td>Pro</td><td>200</td></tr></table><pre><code>const widget = &quot;&lt;Widget&gt;&quot;;</code></pre><p>FINAL_EVIDENCE_42</p></main>`
const shell = script => `<html><head><title>Widget documentation</title></head><body><nav>Navigation noise</nav><div id="app">Loading...</div><script>${script}</script></body></html>`
export const samples = [
  { id: 'ssr', facts },
  { id: 'gzip', facts },
  { id: 'charset', facts: ['中文帮助内容', 'FINAL_EVIDENCE_42'] },
  { id: 'csr-inline', facts, needsJs: true },
  { id: 'csr-fetch', facts, needsJs: true },
  { id: 'csr-external-script', facts, needsJs: true },
  { id: 'hybrid', facts, needsJs: true },
  { id: 'slow-hybrid', facts, needsJs: true },
  { id: 'faq', facts: [...facts, 'FAQ_EVIDENCE_88'] },
  { id: 'hidden-faq', facts: [...facts, 'FAQ_EVIDENCE_88'] },
  { id: 'long-poll', facts, needsJs: true },
  { id: 'loading-shell', reject: true, needsJs: true },
  { id: 'challenge', reject: true },
  { id: 'login', reject: true },
  { id: 'noindex', reject: true },
]

// Logical public URLs exercise the production URL/DNS policy. Only the socket
// destination is redirected to this trusted local fixture; no production code
// accepts loopback addresses or gains a fixture bypass.
export async function startFixtures() {
  const received = new Map(), sent = new Map(), receivedHeaders = new Map(), timers = new Set(), state = { extra: '' }
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer) }
  const server = http.createServer((request, response) => {
    const path = new URL(request.url, origin).pathname
    received.set(path, (received.get(path) ?? 0) + 1)
    receivedHeaders.set(path, request.headers)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('ETag', '"fixture-v1"')
    response.on('error', () => {})
    const end = body => { sent.set(path, (sent.get(path) ?? 0) + Buffer.byteLength(body)); response.end(body) }
    switch (path) {
      case '/ssr': end('<html><head><title>Installation</title></head><body><nav>Noise</nav>' + article + '<footer>Noise</footer></body></html>'); break
      case '/gzip': response.setHeader('Content-Encoding', 'gzip'); end(gzipSync(article)); break
      case '/charset': {
        response.setHeader('Content-Type', 'text/html; charset=gbk')
        end(Buffer.concat([Buffer.from('<main><h1>Guide</h1><p>'), Buffer.from('d6d0cec4b0efd6fac4dac8dd', 'hex'), Buffer.from(' FINAL_EVIDENCE_42. Configure the feedback widget for your team.</p></main>')]))
        break
      }
      case '/csr-inline': end(shell(`document.getElementById('app').innerHTML=${JSON.stringify(article)}`)); break
      case '/csr-fetch': end(shell('fetch("/payload").then(r=>r.json()).then(d=>document.getElementById("app").innerHTML=d.html)')); break
      case '/csr-external-script': end('<html><body><div id="app">Loading...</div><script src="/app.js"></script></body></html>'); break
      case '/app.js': response.setHeader('Content-Type', 'application/javascript'); end('fetch("/payload").then(r=>r.json()).then(d=>document.getElementById("app").innerHTML=d.html)'); break
      case '/hybrid': case '/slow-hybrid': case '/very-slow-hybrid': end(`<html><body><div id="app"><main><h1>Installation</h1><p>The introduction is rendered on the server, but the plan limits are loaded asynchronously.</p></main></div><script>fetch("${path === '/very-slow-hybrid' ? '/very-slow-payload' : path === '/slow-hybrid' ? '/slow-payload' : '/payload'}").then(r=>r.json()).then(d=>document.getElementById("app").innerHTML=d.html)</script></body></html>`); break
      case '/payload': case '/slow-payload': case '/very-slow-payload': response.setHeader('Content-Type', 'application/json'); later(() => end(JSON.stringify({ html: article.replace('</main>', state.extra + '</main>') })), path === '/very-slow-payload' ? 3500 : path === '/slow-payload' ? 1200 : 150); break
      case '/docs': end(shell('fetch("/docs-payload").then(r=>r.json()).then(d=>document.getElementById("app").innerHTML=d.html)')); break
      case '/docs-payload': response.setHeader('Content-Type', 'application/json'); end(JSON.stringify({ html: article.replace('</main>', '<a href="/docs/setup">Setup instructions</a></main>') })); break
      case '/docs/setup': end(article); break
      case '/hybrid-failed': end('<main><h1>Installation</h1><p>The introduction is available but the remaining documentation must load from the content API.</p></main><script>fetch("/missing-content").then(r=>r.json()).then(d=>document.querySelector("main").innerHTML=d.html)</script>'); break
      case '/faq': end(article.replace('</main>', '<details><summary>How do I configure the widget?</summary><p>FAQ_EVIDENCE_88: Enable notifications in the workspace settings.</p></details></main>')); break
      case '/hidden-faq': end(article.replace('</main>', '<button aria-expanded="false" aria-controls="answer" onclick="document.getElementById(\'answer\').hidden=false;this.setAttribute(\'aria-expanded\',\'true\')">How do I configure the widget?</button><section id="answer" hidden><p>FAQ_EVIDENCE_88: Enable notifications in the workspace settings.</p></section></main>')); break
      case '/long-poll': end(article + '<script>fetch("/never");</script>'); break
      case '/never': response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('waiting'); break
      case '/loading-shell': end(shell('').replace('Loading...', 'Loading your documentation. Please wait while the application prepares the complete knowledge content.')); break
      case '/challenge': end('<html><title>Just a moment...</title><body><main><h1>Verify you are human</h1><p>Checking your browser before accessing this website. Enable JavaScript and cookies to continue.</p></main></body></html>'); break
      case '/login': end('<html><title>Sign in</title><body><main><h1>Sign in to access your documentation</h1><p>Enter your account credentials to continue to the workspace and view the private documentation.</p><form><input type="password"></form></main></body></html>'); break
      case '/noindex': end('<meta name="robots" content="noindex">' + article); break
      case '/browser-private': end(article + '<script>fetch("http://private.fixture.example/secret")</script>'); break
      case '/browser-redirect': end(article + '<script>location.href="http://outside.fixture.example/ssr"</script>'); break
      case '/redirect': response.writeHead(302, { Location: '/ssr' }); end(''); break
      case '/redirect-private': response.writeHead(302, { Location: 'http://private.fixture.example/ssr' }); end(''); break
      case '/redirect-outside': response.writeHead(302, { Location: 'http://outside.fixture.example/ssr' }); end(''); break
      case '/not-modified': response.writeHead(request.headers['if-none-match'] ? 304 : 200); end(request.headers['if-none-match'] ? '' : article); break
      case '/transient': response.writeHead(received.get(path) % 2 ? 503 : 200); end(article); break
      case '/retry-queue': response.writeHead(received.get(path) === 1 ? 503 : 200); end(article); break
      case '/aborted': response.write('<main>Partial response'); later(() => response.destroy(), 10); break
      case '/big': case '/compressed-big': {
        const body = Buffer.from('<main><p>' + 'x'.repeat(6 * 1024 * 1024) + '</p></main>')
        if (path === '/compressed-big') { response.setHeader('Content-Encoding', 'gzip'); end(gzipSync(body)) }
        else {
          let offset = 0
          const write = () => {
            if (response.destroyed) return
            const chunk = body.subarray(offset, offset + 65536); offset += chunk.length
            sent.set(path, (sent.get(path) ?? 0) + chunk.length); response.write(chunk)
            if (offset === body.length) response.end(); else later(write, 2)
          }
          write()
        }
        break
      }
      default: response.writeHead(404); end('Not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const fixturePort = server.address().port, originalRequest = http.request, originalResolve = dns.resolve4
  http.request = function (input, options, callback) {
    let url, settings, cb
    if (typeof input === 'string' || input instanceof URL) { url = new URL(input); settings = options ?? {}; cb = callback }
    else { settings = input; cb = options; url = new URL(`http://${settings.hostname || settings.host}${settings.path || '/'}`) }
    // CRI connects its debugging websocket to loopback; it is not a webpage URL.
    if (url.hostname === '127.0.0.1') return Reflect.apply(originalRequest, http, [input, options, callback])
    if (url.hostname !== new URL(origin).hostname) throw new Error(`Unexpected fixture socket: ${url.hostname}`)
    const destination = new URL(url.pathname + url.search, `http://127.0.0.1:${fixturePort}`)
    return originalRequest(destination, { ...settings, hostname: '127.0.0.1', host: '127.0.0.1', port: fixturePort, lookup: undefined, headers: { ...settings.headers, Host: url.host } }, cb)
  }
  dns.resolve4 = async host => {
    if (host === 'private.fixture.example') return ['127.0.0.1']
    if (host.endsWith('.fixture.example')) return ['1.1.1.1']
    throw new Error(`Unexpected fixture DNS: ${host}`)
  }
  syncBuiltinESMExports()
  return {
    received, sent, receivedHeaders, state,
    async close() {
      http.request = originalRequest; dns.resolve4 = originalResolve; syncBuiltinESMExports()
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    },
  }
}
