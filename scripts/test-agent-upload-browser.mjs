import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const base = process.env.INBOX_TEST_BASE || 'http://127.0.0.1:3168'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH})
const page = await browser.newPage()
let uploads=0, chats=0, submitted, release
const gate = new Promise(resolve => release=resolve)
const errors=[]
page.on('pageerror', e=>errors.push(e.message))
await page.route('**/api/widget/config',r=>r.fulfill({json:{org:{name:'Test',logo:null},allowGuest:true,imageMaxBytes:16*1024*1024,branding:{primary:'#333333',primaryForeground:'#ffffff'}}}))
await page.route('**/api/auth/sign-in/anonymous',r=>r.fulfill({json:{token:'local-test',user:{id:'test',name:'Test',email:'test@example.invalid',isAnonymous:true}}}))
await page.route('**/api/auth/get-session',r=>r.fulfill({json:{user:{id:'test',name:'Test',email:'test@example.invalid'}}}))
await page.route('**/api/widget/unread',r=>r.fulfill({json:{feedbackUnread:0,conversationUnread:0}}))
await page.route('**/api/widget/conversations',r=>r.fulfill({json:{data:[]}}))
await page.route('**/api/widget/conversations/*/items*',r=>r.fulfill({json:{items:[],runs:[],conversation:{handling:'ai',lastSeq:0},nextBeforeSeq:null}}))
await page.route('**/api/upload',async r=>{
 uploads++
 assert.match(r.request().postDataBuffer().toString(),/Content-Type: image\/(png|jpeg)/i)
 await gate
 await r.fulfill({json:{key:`uploads/test/${uploads}.png`}})
})
await page.route('**/api/widget/conversations/*/chat',async r=>{
 chats++;submitted=r.request().postDataJSON()
 await r.fulfill({json:{conversation:{handling:'ai'}}})
})
try {
 await page.goto(`${base}/widget/embed`,{waitUntil:'domcontentloaded',timeout:120000})
 const textarea=page.locator('textarea')
 await textarea.waitFor({timeout:60000})
 await textarea.fill('Please compare these images')
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="20" y="30">Error 123</text></svg>')
 const uploadStarted = page.waitForRequest(request => request.url().endsWith('/api/upload'))
 await page.locator('input[type=file]').setInputFiles(Array.from({length:10},(_,i)=>({name:`${i}.svg`,mimeType:'image/svg+xml',buffer:svg})))
 await uploadStarted
 const send=page.getByRole('button',{name:/^send$|^发送$/i})
 assert.equal(await send.isDisabled(),true)
 await textarea.press('Enter')
 assert.equal(chats,0)
 assert.equal(uploads,1)
 release()
 await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(x=>/^(send|发送)$/i.test(x.textContent.trim()))?.disabled)
 assert.equal(uploads,10)
 assert.equal(chats,0)
 await send.click()
 await page.waitForFunction(()=>document.querySelector('textarea')?.value==='')
 assert.equal(chats,1)
 assert.equal(submitted.message.content.parts.filter(p=>p.type==='image').length,10)
 console.log('PASS 10 SVG images converted and uploaded before Send; Enter cannot start a run during upload; one message contains all ten prepared attachments')
 await page.reload({waitUntil:'domcontentloaded'})
 await textarea.waitFor()
 await textarea.fill('Keep this draft')
 const before=uploads
 await page.locator('input[type=file]').setInputFiles(Array.from({length:11},(_,i)=>({name:`${i}.svg`,mimeType:'image/svg+xml',buffer:svg})))
 await page.waitForFunction(()=>document.body.textContent.includes('10'))
 assert.equal(uploads,before)
 assert.equal(await send.isDisabled(),true)
 assert.equal(chats,1)
 console.log('PASS excessive selection rejected before upload and unresolved image error blocks Send')
 assert.deepEqual(errors,[])
} finally {release(); await browser.close()}
