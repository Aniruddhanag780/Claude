import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Tooltip } from '@/components/tooltip'

// Built-in per-key concurrency defaults (#1347, opt-in): when on, the major
// free-tier platforms fall back to a conservative built-in per-key cap unless
// a MAX_CONCURRENT_REQUESTS_PER_KEY* env var says otherwise. Independent of
// the routing-strategy snapshot — it lives in settings, so it owns its own
// query + mutation. Off by default.
async function fetchBuiltin(): Promise<{ enabled: boolean }> {
  return apiFetch('/api/settings/builtin-key-concurrency')
}

export function BuiltinConcurrencyControl() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['settings', 'builtin-key-concurrency'], queryFn: fetchBuiltin })
  const enabled = data?.enabled ?? false

  const mutation = useMutation({
    mutationFn: (value: boolean) =>
      apiFetch('/api/settings/builtin-key-concurrency', {
        method: 'PUT',
        body: JSON.stringify({ enabled: value }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'builtin-key-concurrency'] }),
  })

  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('strategies.builtinKeyConcurrency')}</span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={mutation.isPending}
        onChange={e => mutation.mutate(e.target.checked)}
        className="h-3.5 w-3.5 accent-foreground"
      />
      <Tooltip text={t('strategies.builtinKeyConcurrencyHint')}>
        <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
      </Tooltip>
    </label>
  )
}
