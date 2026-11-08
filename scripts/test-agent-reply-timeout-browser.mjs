import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const base=process.env.INBOX_TEST_BASE || 'http://127.0.0.1:3168'
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname))
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH})
const page=await browser.newPage()
let sent, calls=0, stalled=false, blockedRoute
const runId=crypto.randomUUID(), replyId=crypto.randomUUID()
await page.route('**/api/widget/config',r=>r.fulfill({json:{org:{name:'Test',logo:null},allowGuest:true,branding:{primary:'#333333',primaryForeground:'#ffffff'}}}))
await page.route('**/api/auth/sign-in/anonymous',r=>r.fulfill({json:{token:'test',user:{id:'test',name:'Test',email:'test@example.invalid'}}}))
await page.route('**/api/auth/get-session',r=>r.fulfill({json:{user:{id:'test',name:'Test',email:'test@example.invalid'}}}))
await page.route('**/api/widget/conversations',r=>r.fulfill({json:{data:[]}}))
await page.route('**/api/widget/unread',r=>r.fulfill({json:{}}))
await page.route('**/api/widget/conversations/*/items*',r=>r.fulfill({json:{conversation:{handling:'ai',lastSeq:1},items:sent?[{id:sent.message.id,seq:1,authorType:'customer',content:sent.message.content,createdAt:new Date().toISOString(),context:null}]:[],runs:[{id:runId,status:'failed',error:stalled?'ai_timeout':'ai_error',startedAt:new Date().toISOString(),triggerItemId:sent?.message.id}],nextBeforeSeq:null}}))
await page.route('**/api/widget/conversations/*/chat',async r=>{
 calls++
 const body=r.request().postDataJSON()
 if(body.action==='send') sent=body
 else {assert.equal(body.action,'retry');assert.equal(body.trigger_item_id,sent.message.id)}
 if(stalled) {blockedRoute=r;return}
 const sse=(event,data)=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
 await r.fulfill({contentType:'text/event-stream',body:sse('run',{runId,itemId:replyId})+sse('text',{delta:'INCOMPLETE ANSWER SHOULD DISAPPEAR'})+sse('error',{code:'ai_error',message:'failure'})})
})
try {
 await page.goto(`${base}/widget/embed`,{waitUntil:'domcontentloaded'})
 await page.locator('textarea').fill('A question')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 const retry=page.getByRole('button',{name:'Retry reply',exact:true})
 await retry.waitFor()
 assert.equal(await page.getByText('INCOMPLETE ANSWER SHOULD DISAPPEAR').count(),0)
 await page.getByText('The response was interrupted. Please retry.',{exact:true}).waitFor()
 await retry.click()
 await retry.waitFor()
 assert.equal(calls,2)
 console.log('PASS interrupted text cleared, existing error and retry button work, retry targets the same customer message')
 await page.reload({waitUntil:'domcontentloaded'})
 await page.locator('textarea').waitFor()
 await page.clock.install()
 stalled=true
 await page.locator('textarea').fill('Wait for first answer')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 for(let i=0;!blockedRoute && i<50;i++) await new Promise(r=>setTimeout(r,20))
 assert.ok(blockedRoute)
 await page.clock.fastForward(119000)
 assert.equal(await page.getByText('The response timed out. Please retry.',{exact:true}).count(),0)
 await page.clock.fastForward(1001)
 await page.getByText('The response timed out. Please retry.',{exact:true}).waitFor()
 await retry.waitFor()
 console.log('PASS no first answer at 120 seconds aborts waiting and shows the existing timeout/retry controls')
} finally {if(blockedRoute) await blockedRoute.abort().catch(()=>{});await browser.close()}
