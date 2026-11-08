import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const base = process.env.INBOX_TEST_BASE || 'http://127.0.0.1:3168'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH})
const page = await browser.newPage()
const errors=[]
page.on('pageerror', e=>errors.push(e.message))
await page.route('**/api/widget/config',r=>r.fulfill({json:{org:{name:'Test',logo:null},allowGuest:true,imageMaxBytes:16*1024*1024,branding:{primary:'#333333',primaryForeground:'#ffffff'}}}))
await page.route('**/api/auth/sign-in/anonymous',r=>r.fulfill({json:{token:'local-test',user:{id:'test',name:'Test',email:'test@example.invalid',isAnonymous:true}}}))
await page.route('**/api/auth/get-session',r=>r.fulfill({json:{user:{id:'test',name:'Test',email:'test@example.invalid'}}}))
await page.route('**/api/widget/unread',r=>r.fulfill({json:{feedbackUnread:0,conversationUnread:0}}))
await page.route('**/api/widget/conversations',r=>r.fulfill({json:{data:[]}}))
await page.route('**/api/widget/conversations/*/items*',r=>r.fulfill({json:{items:[],runs:[],conversation:{handling:'ai',lastSeq:0},nextBeforeSeq:null}}))

let uploaded
await page.route('**/api/upload',async r=>{
 const data=r.request().postDataBuffer()
 const start=data.indexOf(Buffer.from('\r\n\r\n'))+4
 const end=data.lastIndexOf(Buffer.from('\r\n--'))
 uploaded([...data.subarray(start,end)])
 await r.fulfill({json:{key:'uploads/test/review.png'}})
})
try{
 await page.goto(`${base}/widget/embed`,{waitUntil:'domcontentloaded'})
 await page.locator('textarea').waitFor()
 const fixtures = [
  '<defs><rect id="square" width="100" height="100" fill="red"/></defs><use href="#square"/>',
  '<style>.square { fill: rgb(255,0,0) }</style><rect class="square" width="100" height="100"/>',
  '<defs><linearGradient id="gradient"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><rect id="square" width="100" height="100" fill="url(#gradient)"/></defs><use xlink:href="#square"/>',
  '<rect width="100" height="100" fill="red"/><script>window.svgExecuted = true</script>',
  '<image width="100" height="100" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII="/>',
 ]
 for (const [index, fixture] of fixtures.entries()) {
 const ready = new Promise(resolve => uploaded=resolve)
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">${fixture}</svg>`
 await page.locator('input[type=file]').setInputFiles({name:'symbols.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg)})
 const bytes=await ready
 const result=await page.evaluate(async({bytes,svg})=>{
  const count=async blob=>{const img=new Image();const url=URL.createObjectURL(blob);img.src=url;await img.decode();const c=document.createElement('canvas');c.width=c.height=100;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const p=ctx.getImageData(0,0,100,100).data;URL.revokeObjectURL(url);return [...p]}
  return {originalVisiblePixels:await count(new Blob([svg],{type:'image/svg+xml'})),uploadedVisiblePixels:await count(new Blob([new Uint8Array(bytes)],{type:'image/png'}))}
 },{bytes,svg})
 assert.deepEqual(result.uploadedVisiblePixels,result.originalVisiblePixels)
 assert.equal(await page.evaluate(()=>window.svgExecuted),undefined)
 console.log(`PASS SVG fixture ${index + 1}: uploaded PNG matches source pixels`)
 await page.waitForFunction(()=>!document.querySelector('input[type=file]')?.disabled)
 await page.waitForTimeout(300)
 }
 let unexpectedUpload = false
 uploaded = () => { unexpectedUpload = true }
 await page.locator('input[type=file]').setInputFiles({ name:'external.svg', mimeType:'image/svg+xml', buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="https://example.invalid/image.png" width="100" height="100"/></svg>') })
 await page.getByText('This image could not be converted. Try exporting it as JPEG or PNG.', { exact: true }).waitFor()
 assert.equal(unexpectedUpload,false)
 console.log('PASS external SVG dependency rejected before upload')
 assert.deepEqual(errors,[])
}finally{await browser.close()}
