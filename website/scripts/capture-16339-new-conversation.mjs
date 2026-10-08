/**
 * Screenshot harness for "New conversation" on a crewmate's DM (#16339).
 *
 * Four states, which are the ones a reviewer has to judge:
 *
 *   01  the control in the thread header, beside the panel toggle
 *   02  the confirm dialog — what is forgotten, and what survives
 *   03  the thread after the reset: the discarded rows behind
 *       "Show earlier messages", the fresh thread's own hint below it
 *   04  the same thread with the earlier messages revealed
 *   05  the control DISABLED while the crewmate is working
 *
 * Runs the REAL built SPA behind `serveDist` with every `/api/**` answered from
 * fixtures (`stubDashboardApi`): no gateway, no auth, no kiro-cli. The boundary
 * is served the way production serves it — on the roster row's own `roster`
 * projection block — so what the pane draws here is what it draws live.
 *
 * Usage: node scripts/capture-16339-new-conversation.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { json } from './lib/boot-api.mjs'
import { serveDist } from './lib/serve-dist.mjs'
import { stubDashboardApi, logPageProblems } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || join(process.env.KIROCREW_SCRATCH || '.', '16339')
mkdirSync(OUT, { recursive: true })

const now = Math.floor(Date.now() / 1000)
const iso = (secsAgo) => new Date((now - secsAgo) * 1000).toISOString()
const SLOT = 'member-kiro'
/** The reset moment: 30 minutes ago, between the two halves of the transcript. */
const BOUNDARY_MS = (now - 1800) * 1000

const member = (name, extra = {}) => ({
  name, slug: name, bound: true, slot_key: `member-${name}`, running: false,
  kiro_agent: 'kirocrew', workspace: `/srv/repos/${name}`, memory_store: `member-${name}`,
  memory_version: 2, memory_owner: name, model: '', source: 'kirocrew', ...extra,
})

/** The roster row's projection block, exactly as `GET /api/members` ships it. */
const projections = (conversationStarts) => ({
  asOfSeq: 41,
  values: {
    roster: {
      name: 'kiro',
      slug: 'kiro',
      kiro_agent: 'kirocrew',
      workspace: '/srv/repos/kiro',
      memory_store: 'member-kiro',
      display_name: 'Kiro',
      slot_key: SLOT,
      ...(conversationStarts ? { conversation_starts: conversationStarts } : {}),
    },
  },
})

const members = ({ reset = false, running = false, boundaryMs = BOUNDARY_MS } = {}) => [
  member('kiro', {
    display_name: 'Kiro',
    running,
    last_active_ts: now - 120,
    last_message: 'Opening the PR now.',
    projections: projections(reset ? { [SLOT]: { message_seq: 4, ts: boundaryMs } } : null),
  }),
  member('atlas', { display_name: 'Atlas', last_active_ts: now - 5400, last_message: 'The gateway boots in 1.4s.' }),
  member('scout', { display_name: 'Scout', last_active_ts: now - 90000, last_message: 'Same conclusion as #3202.' }),
]

/** Two conversations in ONE transcript: the reset sits between them. */
const DISCARDED = [
  { role: 'user', content: 'Which file owns the slot reset route?', cls: '', ts: iso(5400) },
  { role: 'assistant', content: 'The chat API owns it: `slot_lifecycle.py` holds the reset handler beside the shared close path.', cls: '', ts: iso(5340) },
  { role: 'user', content: 'And the member log?', cls: '', ts: iso(5200) },
  { role: 'assistant', content: 'One log per crewmate, append-only. The `slot` domain is the member kind\u2019s, so the boundary belongs there.', cls: '', ts: iso(5100) },
]
const CURRENT = [
  { role: 'user', content: 'Start again: what does the reset button do?', cls: '', ts: iso(900) },
  { role: 'assistant', content: 'It gives this thread a fresh context. The slot key, the channel linkage and the transcript all stay; only what the model remembers is dropped.', cls: '', ts: iso(840) },
]

const detail = (messages) => ({
  messages, running: false, has_more: false, total: messages.length, next_before: 0,
})

/** Live presence, which is what the control's disabled state reads: a slot frame
 *  WINS over the roster row's own `running`, because the frame is the live fact
 *  and the row is the last read. So the busy case is seeded here, not on the
 *  row. */
const slots = (running = false) => [
  { key: SLOT, title: 'Kiro', mode: 'member', created: iso(86400), last_ts: iso(120), running, project: '/srv/repos/kiro', agent: 'kiro' },
]
const STORAGE = {
  'mc-lang': 'en',
  'mc-crewmates-onboarded': '1',
  'mc-crewmates-page-entered': '1',
  'mc-nav': '1',
  'mc-members-panel-open': '0',
}

let failed = false
function check(name, ok, detailText = '') {
  console.log(`${name}: ${ok ? 'OK' : 'MISMATCH'} ${detailText}`)
  if (!ok) failed = true
  return ok
}

const { srv, base } = await serveDist()
const browser = await chromium.launch()

/** One page on the Crewmates page with Kiro's DM open. */
async function open({ reset = false, running = false, messages, boundaryMs = BOUNDARY_MS, refuse = false, boundaryFailed = false, viewport = { width: 1500, height: 940 } }) {
  const extra = async (path, route) => {
    if (path === '/api/members') {
      await json(route, { members: members({ reset, running, boundaryMs }), default_agent: 'kirocrew' })
      return true
    }
    if (path === '/api/default-agent') { await json(route, { default_agent: 'kirocrew' }); return true }
    if (path === '/api/teams') { await json(route, { teams: [] }); return true }
    if (path === '/api/autonudge') { await json(route, { enabled: true, loops: [] }); return true }
    const thread = path.match(/^\/api\/members\/([^/]+)\/thread$/)
    if (thread) {
      const slug = decodeURIComponent(thread[1])
      await json(route, { slot_key: `member-${slug}`, slug, member: slug, created: false })
      return true
    }
    if (/^\/api\/members\/[^/]+\/activity$/.test(path)) {
      await json(route, { slug: '', member: '', capped: false, entries: [] })
      return true
    }
    if (/^\/api\/members\/[^/]+\/briefing$/.test(path)) {
      await json(route, { slug: '', member: '', supported: true, text: '', updated_ts: null, redacted: false, truncated: false })
      return true
    }
    if (/^\/api\/members\/[^/]+\/panel$/.test(path)) { await json(route, { panel: null, html: null }); return true }
    if (/^\/api\/chat\/slots\/[^/]+\/reset-conversation$/.test(path)) {
      if (refuse) {
        // Exactly what the route answers for busy state the page cannot see:
        // an inbound channel message, or a turn admitted between the render
        // and the press.
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'a turn is in flight', code: 'turn_in_flight', slot: SLOT }),
        })
        return true
      }
      await json(route, { slot: SLOT, reset: true, replay: false, boundary: boundaryFailed ? 'failed' : 'recorded' })
      return true
    }
    if (path.startsWith('/api/chat/slots/') && !path.endsWith('/folder')) {
      await json(route, detail(messages))
      return true
    }
    return false
  }

  const context = await browser.newContext({
    viewport,
    // The header row is 11-13px type; 1x renders it soft on GitHub.
    deviceScaleFactor: 2,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  logPageProblems(page)
  await stubDashboardApi(page, { theme: 'light', extra, slots: slots(running), localStorageEntries: STORAGE })
  await page.goto(`${base}/members?member=kiro`, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('member-identity-pill').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(700)
  return { context, page }
}

// 01 + 02: the control, and the ask. No boundary yet -- this is the thread as
// it stands before anyone has pressed it, which is the state the button is
// offered from.
{
  const { context, page } = await open({ messages: [...DISCARDED, ...CURRENT] })
  const button = page.getByTestId('member-new-conversation')
  await button.waitFor({ state: 'visible', timeout: 15000 })
  check('the control is in the thread header', await button.isVisible())
  check('it is enabled while the crewmate rests', await button.isEnabled())
  check('the whole transcript is drawn before any reset', (await page.getByText('And the member log?').count()) === 1)
  check('no boundary marker before a reset', (await page.getByTestId('conversation-boundary-row').count()) === 0)
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(OUT, '01-control-in-header.png') })
  await page.getByTestId('member-thread-header').screenshot({ path: join(OUT, '01b-header-closeup.png') })

  await button.click()
  const ask = page.getByText(/starts over/)
  await ask.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(400)
  const copy = await ask.innerText()
  check('the ask names the crewmate, quoted', /^\u201cKiro\u201d starts over/.test(copy), copy)
  check('the ask says what survives, in plain words', /What it has saved to its memory stays/.test(copy), copy)
  check('the ask says what the crewmate forgets', /will not remember anything said in this chat/.test(copy))
  check('the ask says where the earlier messages are', /Show earlier messages/.test(copy))
  await page.screenshot({ path: join(OUT, '02-confirm-dialog.png') })
  await context.close()
}

// 03 + 04: the thread AFTER the reset, served the way a reload serves it -- the
// boundary on the roster projection, the transcript untouched.
{
  const { context, page } = await open({ reset: true, messages: [...DISCARDED, ...CURRENT] })
  const earlier = page.getByTestId('chat-pane-show-earlier')
  await earlier.waitFor({ state: 'visible', timeout: 15000 })
  check('the discarded rows are hidden', (await page.getByText('And the member log?').count()) === 0)
  check('the current conversation is drawn', (await page.getByText(/Start again: what does the reset button do\?/).count()) === 1)
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(OUT, '03-after-reset-collapsed.png') })

  await earlier.click()
  await page.getByText('And the member log?').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(400)
  check('the boundary stays marked once the history is drawn', (await page.getByTestId('conversation-boundary-row').count()) === 1)
  check('and it now collapses instead', (await page.getByTestId('chat-pane-hide-earlier').count()) === 1)
  await page.screenshot({ path: join(OUT, '04-earlier-messages-revealed.png') })
  await context.close()
}

// 05: working. The route refuses a busy slot anyway; the disabled control is
// the honest state rather than the enforcement.
{
  const { context, page } = await open({ running: true, messages: [...DISCARDED, ...CURRENT] })
  const button = page.getByTestId('member-new-conversation')
  await button.waitFor({ state: 'visible', timeout: 15000 })
  check('the control is disabled while the crewmate works', await button.isDisabled())
  await page.mouse.move(5, 5)
  await page.getByTestId('member-thread-header').screenshot({ path: join(OUT, '05-disabled-while-working.png') })
  await context.close()
}

// 06: the thread the instant after the reset, before anything new is said --
// the boundary row plus the fresh-thread hint, which is what the user actually
// lands on. The boundary sits past every row, so nothing is current yet.
{
  const { context, page } = await open({ reset: true, boundaryMs: Date.now(), messages: [...DISCARDED, ...CURRENT] })
  await page.getByTestId('conversation-boundary-row').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(400)
  check('nothing from before the reset is drawn', (await page.getByText(/Start again: what does the reset button do\?/).count()) === 0)
  check('the thread reads as fresh, not as a quiet crewmate', (await page.getByTestId('crewmate-quiet-hint').count()) === 0)
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(OUT, '06-fresh-thread-after-reset.png') })
  await context.close()
}

// 07: the refusal. The route answers 409 for busy state the button cannot see,
// and swallowing it would read as "nothing happened" over a conversation the
// model still remembers.
{
  const { context, page } = await open({ refuse: true, messages: [...DISCARDED, ...CURRENT] })
  await page.getByTestId('member-new-conversation').click()
  const confirm = page.getByRole('button', { name: 'Start a new conversation' })
  await confirm.waitFor({ state: 'visible', timeout: 10000 })
  await confirm.click()
  const notice = page.getByTestId('member-new-conversation-error')
  await notice.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(400)
  check('a refusal is on screen above the thread', await notice.isVisible())
  check('the conversation is still drawn under it', (await page.getByText(/Start again: what does the reset button do\?/).count()) === 1)
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(OUT, '07-refusal-notice.png') })
  await context.close()
}

// 09: the reset ran and its boundary did not. The one outcome where a clean
// success would be a lie about what is on screen: the crewmate has forgotten the
// messages still drawn, and no line marks them. Its own heading, because the
// refusal heading over this body says the reverse of the body.
{
  const { context, page } = await open({ boundaryFailed: true, messages: [...DISCARDED, ...CURRENT] })
  await page.getByTestId('member-new-conversation').click()
  const confirm = page.getByRole('button', { name: 'Start a new conversation' })
  await confirm.waitFor({ state: 'visible', timeout: 10000 })
  await confirm.click()
  const notice = page.getByTestId('member-new-conversation-error')
  await notice.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(400)
  const copy = await notice.innerText()
  check('the heading does not contradict the body', /New conversation started, line not saved/.test(copy) && !/Couldn't start a new conversation/.test(copy), copy.replace(/\n/g, ' | '))
  check('it names an action a reload cannot do', /Press New conversation again to save the line/.test(copy) && !/Reload/.test(copy))
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(OUT, '09-boundary-not-saved.png') })
  await context.close()
}

// 10: the busy refusal, in the user's words. "a turn is in flight" is the code's
// term for a state the pill beside it already renders as working.
{
  const { context, page } = await open({ refuse: true, messages: [...DISCARDED, ...CURRENT] })
  await page.getByTestId('member-new-conversation').click()
  const confirm = page.getByRole('button', { name: 'Start a new conversation' })
  await confirm.waitFor({ state: 'visible', timeout: 10000 })
  await confirm.click()
  const notice = page.getByTestId('member-new-conversation-error')
  await notice.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(400)
  const copy = await notice.innerText()
  check('the busy refusal says WHY, not just that it failed', /Kiro is handling a message right now/.test(copy) && !/turn is in flight/.test(copy), copy.replace(/\n/g, ' | '))
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(OUT, '10-busy-refusal.png') })
  await context.close()
}

// 08: 320px. The header pair and the boundary row both have to stay inside the
// pane: a non-shrinking label beside the panel toggle runs over the centred
// identity pill, and a non-wrapping boundary group is clipped by the
// transcript's own hidden horizontal overflow -- taking the reveal with it.
{
  const { context, page } = await open({ reset: true, messages: [...DISCARDED, ...CURRENT], viewport: { width: 320, height: 760 } })
  const control = page.getByTestId('chat-pane-show-earlier')
  await control.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(400)
  const box = await control.boundingBox()
  check(`the reveal is inside the 320px pane (right edge ${Math.round(box.x + box.width)})`, box.x >= 0 && box.x + box.width <= 320)
  const button = page.getByTestId('member-new-conversation')
  const bb = await button.boundingBox()
  check(`the header control is inside it too (right edge ${Math.round(bb.x + bb.width)})`, bb.x >= 0 && bb.x + bb.width <= 320)
  check('the glyph carries the name below sm', (await button.getAttribute('aria-label')) === 'New conversation')
  // Inside the viewport is NOT enough. The header keeps the identity pill
  // page-centred between two `1fr` sides, so a side cell whose content exceeds
  // its share sits inside the pane and is painted UNDER the pill. Overlap is the
  // thing to assert, and it is what a width check alone let through.
  const pill = await page.getByTestId('member-identity-pill').boundingBox()
  const gap = bb.x - (pill.x + pill.width)
  check(`the pill does not overlap the control (gap ${Math.round(gap)}px)`, gap >= 0)
  await page.screenshot({ path: join(OUT, '08-narrow-320px.png') })
  await context.close()
}

// 11: 640px, where the side cells have room for a word. Below this the glyph
// carries the control's name through `aria-label` and `title`; from here a
// reader sees one.
{
  const { context, page } = await open({ reset: true, messages: [...DISCARDED, ...CURRENT], viewport: { width: 640, height: 820 } })
  const button = page.getByTestId('member-new-conversation')
  await button.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(400)
  check('a word is on the control at 640px', (await button.innerText()).trim() === 'New')
  const bb2 = await button.boundingBox()
  const pill2 = await page.getByTestId('member-identity-pill').boundingBox()
  const gap2 = bb2.x - (pill2.x + pill2.width)
  check(`and the pill still does not overlap it (gap ${Math.round(gap2)}px)`, gap2 >= 0)
  await page.mouse.move(5, 5)
  await page.getByTestId('member-thread-header').screenshot({ path: join(OUT, '11-narrow-640px-header.png') })
  await context.close()
}

await browser.close()
srv.close()
console.log(`\nwrote ${OUT}`)
process.exit(failed ? 1 : 0)
