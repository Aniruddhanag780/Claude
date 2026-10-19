import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Tooltip } from '@/components/tooltip'

// Hedged racing (#1347 PR 3): ms of silence on the first candidate before the
// router's next pick is started in parallel — the faster response wins, the
// loser is canceled. null = off (the default): a hedged request may bill the
// provider twice, so nothing races until the operator opts in here.
async function fetchHedgeMs(): Promise<number | null> {
  const data = await apiFetch<{ ms: number | null }>('/api/settings/hedge-after-ms')
  return data.ms
}

export function HedgeAfterMsControl() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings', 'hedge-after-ms'], queryFn: fetchHedgeMs })
  const ms = data ?? null

  const [text, setText] = useState(ms == null ? '' : String(ms))
  // Re-sync when the server value changes under us (poll, or another tab).
  useEffect(() => { setText(ms == null ? '' : String(ms)) }, [ms])

  const mutation = useMutation({
    mutationFn: (value: number | null) =>
      apiFetch('/api/settings/hedge-after-ms', {
        method: 'PUT',
        body: JSON.stringify({ ms: value }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'hedge-after-ms'] }),
  })

  const invalid = text !== '' && (!/^\d+$/.test(text) || Number(text) > 600000)

  function commit(next: string) {
    setText(next)
    if (next === '') { mutation.mutate(null); return }
    const n = Number(next)
    if (Number.isInteger(n) && n >= 0 && n <= 600000) mutation.mutate(n)
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('strategies.hedgeAfterMs')}</span>
      <input
        type="number"
        min={0}
        max={600000}
        step={100}
        value={text}
        placeholder={t('strategies.hedgeAfterMsOff')}
        disabled={mutation.isPending}
        onChange={e => commit(e.target.value)}
        className="w-20 rounded-lg border bg-background px-2 py-1.5 text-xs text-foreground tabular-nums outline-none focus:border-foreground/30"
      />
      <span>ms</span>
      <Tooltip text={t('strategies.hedgeAfterMsHint')}>
        <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
      </Tooltip>
      {invalid && <span className="text-destructive">0–600000</span>}
    </label>
  )
}
