import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {chromium} from 'playwright-core'
const strings=JSON.parse(readFileSync(new URL('../i18n/locales/en.json', import.meta.url),'utf8')).widget.conversationNotices
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH})
const base = process.env.INBOX_TEST_BASE || 'http://127.0.0.1:3168'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
try {
for(const kind of ['unavailable', 'missing-ai', 'finish']) {
 const context=await browser.newContext({viewport:{width:480,height:650}})
 const page=await context.newPage()
 let sent,conversationId,accepted=false,historyCalls=0
 const runId=crypto.randomUUID(),replyId=crypto.randomUUID(),noticeId=`handoff:${runId}`
 const silent=['unavailable','missing-ai'].includes(kind)
 await page.route('**/api/widget/config',r=>r.fulfill({json:{org:{name:'Test',logo:null},allowGuest:true,branding:{primary:'#c05743',primaryForeground:'#ffffff'}}}))
 await page.route('**/api/auth/sign-in/anonymous',r=>r.fulfill({json:{token:'test',user:{id:'test',name:'Test',email:'test@example.invalid'}}}))
 await page.route('**/api/auth/get-session',r=>r.fulfill({json:{user:{id:'test',name:'Test',email:'test@example.invalid'}}}))
 await page.route('**/api/widget/conversations',r=>r.fulfill({json:{data:accepted?[{id:conversationId,title:'Saved transfer test',firstUserText:'Please help with my request',preview:'Please help with my request',lastMessageAt:new Date().toISOString(),lastSeq:2,unread:false,handling:kind==='unavailable'?'ai':'human'}]:[]}}))
 await page.route('**/api/widget/unread',r=>r.fulfill({json:{}}))
 await page.route('**/api/widget/conversations/*/items*',async r=>{
  if(accepted && ++historyCalls>=1){await r.fulfill({status:503,json:{message:'Synthetic history failure'}});return}
  if(accepted)await new Promise(resolve=>setTimeout(resolve,500))
  const items=sent?[{id:sent.message.id,seq:1,authorType:'customer',content:sent.message.content,createdAt:new Date().toISOString(),context:null}]:[]
  if(accepted&&!silent)items.push({id:noticeId,seq:2,authorType:'system',notice:'handoff',handoffNotice:kind,content:{parts:[{type:'text',text:strings[kind]}]},createdAt:new Date().toISOString(),context:null})
  await r.fulfill({json:{conversation:{handling:accepted&&kind!=='unavailable'?'human':'ai',lastSeq:items.length},items,runs:accepted?[{id:runId,status:kind==='unavailable'?'failed':'cancelled',error:kind==='unavailable'?'support_unavailable':null,startedAt:new Date().toISOString(),triggerItemId:sent?.message.id}]:[],nextBeforeSeq:null}})
 })
 await page.route('**/api/widget/conversations/*/chat',async r=>{
  sent=r.request().postDataJSON();conversationId=r.request().url().split('/').at(-2);accepted=true
  const sse=(event,data)=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  let body=sse('run',{runId,itemId:replyId})+sse('text',{delta:'TEMPORARY TEXT MUST DISAPPEAR'})
  body+=kind==='finish'?sse('finish',{runId,itemId:replyId,lastSeq:2,content:{parts:[{type:'text',text:'Verified final answer'}]}}):kind==='unavailable'?sse('handoff_unavailable',{runId}):sse('handoff',{runId,noticeItemId:noticeId,lastSeq:2,handling:'human',...(kind==='missing-ai'?{reason:'ai_error'}:{handoffNotice:kind})})
  await r.fulfill({contentType:'text/event-stream',body})
 })
 await page.goto(`${base}/widget/embed`,{waitUntil:'domcontentloaded'})
 await page.locator('textarea').fill('Please help with my request')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 if(kind==='finish')await page.getByText('Verified final answer',{exact:true}).waitFor()
 await page.waitForTimeout(1000)
 const verify=async()=>{
  assert.equal(await page.getByText('TEMPORARY TEXT MUST DISAPPEAR').count(),0)
  assert.equal(await page.getByRole('button',{name:'Retry reply',exact:true}).count(),0)
  const interrupted=await page.getByText('The response was interrupted. Please retry.',{exact:true}).count()
  console.log('terminal result after history failure:',{kind,interrupted,historyCalls})
  assert.equal(interrupted,0,'History failure must not turn silent handoff into an interruption')
  await page.locator('textarea').fill('Next message')
  assert.equal(await page.getByRole('button',{name:/^send$/i}).isDisabled(),false)
  assert.equal(await page.getByText('Support is currently unavailable. Your message is saved; please try again later.',{exact:true}).count(),0)
  assert.equal(await page.locator('[data-handoff-message]').count(),0)
  if(kind==='finish')assert.equal(await page.getByText('Verified final answer',{exact:true}).count(),1)
 }
 await verify()
 await context.close()
}
}finally{await browser.close()}
