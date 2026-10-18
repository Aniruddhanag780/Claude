// @vitest-environment jsdom
// The 'decision' strategy's settings popover (#1354): pick the decision model
// and the minimum confidence, see since-restart picks, warn when nothing can
// decide. Nothing is saved until Apply.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { DecisionRoutingStatus } from '@/lib/routing'
import { DecisionRoutingPopover } from './decision-routing-popover'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const status = (over: Partial<DecisionRoutingStatus> = {}): DecisionRoutingStatus => ({
  model: 'auto', minProbability: 0.5, ready: true,
  counts: { smartest: 3, fastest: 5, balanced: 2, reliable: 0 }, fallbacks: { low_confidence: 1 }, ...over,
})

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/decisions/models') {
      return [
        { id: 1, platform: 'cloudflare', modelId: '@cf/cloudflare/clef-flash', displayName: 'Clef Flash', priority: 0, enabled: true },
        { id: 2, platform: 'openrouter', modelId: 'inception/mercury-decide:free', displayName: 'Mercury Decide (free)', priority: 1, enabled: false },
      ]
    }
    return {}
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); document.body.innerHTML = '' })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function open(s: DecisionRoutingStatus, onSave = vi.fn()) {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <DecisionRoutingPopover status={s} saving={false} onSave={onSave} />
      </I18nProvider>
    </QueryClientProvider>
  ))
  await flush()
  const trigger = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Adjust')) as HTMLButtonElement
  await act(async () => { trigger.click() })
  await flush()
  return onSave
}

const body = () => document.body.textContent ?? ''

it('shows settings, enabled decision models and since-restart picks', async () => {
  await open(status())
  expect(body()).toContain('Decision routing')
  const select = document.body.querySelector('select') as HTMLSelectElement
  expect([...select.options].map(o => o.textContent)).toEqual(['Auto (first available)', 'Clef Flash'])
  expect(body()).toContain('Picks since restart (10)')
  expect(body()).toContain('1 routed as Balanced')
  expect(body()).not.toContain('No decision model is ready')
})

it('warns when no decision model can answer', async () => {
  await open(status({ ready: false, counts: { smartest: 0, fastest: 0, balanced: 0, reliable: 0 }, fallbacks: {} }))
  expect(body()).toContain('No decision model is ready')
  expect(body()).not.toContain('Picks since restart')
})

it('saves the chosen model and minimum confidence only on Apply', async () => {
  const onSave = await open(status())
  const select = document.body.querySelector('select') as HTMLSelectElement
  const slider = document.body.querySelector('input[type="range"]') as HTMLInputElement
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setValue.call(select, '@cf/cloudflare/clef-flash')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(slider, '70')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onSave).not.toHaveBeenCalled()
  const apply = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Apply') as HTMLButtonElement
  await act(async () => { apply.click() })
  expect(onSave).toHaveBeenCalledWith({ decisionModel: '@cf/cloudflare/clef-flash', decisionMinProbability: 0.7 })
})
