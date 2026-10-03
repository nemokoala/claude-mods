import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Gauge, Snapshot } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)

const CELLS = 8
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function toSnapshot(limits: SessionRateLimit[]): Snapshot {
  const pick = (match: (kind: string) => boolean): Gauge | undefined => {
    const l = limits.find(x => match(x.kind))
    return l ? { percent: l.percentUsed, resetsAt: l.resetsAt } : undefined
  }
  return {
    fiveHour: pick(k => k === 'five_hour'),
    sevenDay: pick(k => k === 'seven_day'),
  }
}

let lastAccountFetch = 0

type AccountLimit = {
  kind?: string
  percent?: number
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null } | null
}

// The per-model weekly windows (Fable) are not among the session's rate
// limits, so read them from the account usage endpoint the app's usage card
// uses. The host attaches the credential; the module never sees it.
async function fetchFable($: EngineInterface, force = false): Promise<void> {
  const t = await $.clock.now()
  if (!force && t - lastAccountFetch < 120_000) return
  lastAccountFetch = t
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return
    const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return
    const body = JSON.parse(res.text) as { limits?: AccountLimit[] }
    // The per-model weekly window is a `weekly_scoped` limit naming its model.
    const w = (body.limits ?? []).find(
      l => l.kind === 'weekly_scoped' && /fable/i.test(l.scope?.model?.display_name ?? ''),
    )
    if (!w || typeof w.percent !== 'number') return
    const fable: Gauge = { percent: w.percent, resetsAt: w.resets_at ?? undefined }
    await update($, usage, prev => ({ ...(prev ?? {}), fable }))
  } catch {
    // Off a claude.ai login or offline: the gauge just stays absent.
  }
}

function bar(percent: number): { filled: string; track: string } {
  const eighths = Math.round((percent / 100) * CELLS * 8)
  const full = Math.min(Math.floor(eighths / 8), CELLS)
  const part = full < CELLS ? EIGHTHS[eighths % 8] : ''
  const used = full + (part ? 1 : 0)
  return { filled: '█'.repeat(full) + part, track: '░'.repeat(CELLS - used) }
}

function remaining(resetsAt: string | undefined, nowMs: number): string {
  if (!resetsAt) return ''
  let s = Math.floor((Date.parse(resetsAt) - nowMs) / 1000)
  if (isNaN(s)) return ''
  if (s <= 0) return 'now'
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

type Tone = { main: string; light: string }
const toneFor = (p: number): Tone =>
  p >= 80 ? { main: '#ef4444', light: '#fb7185' }
  : p >= 50 ? { main: '#f59e0b', light: '#fcd34d' }
  : { main: '#10b981', light: '#5eead4' }

// A rounded pill gauge with a soft gradient fill, for surfaces that draw SVG.
function pill(percent: number, tone: Tone, w = 88, h = 8): string {
  const r = h / 2
  const fw = percent <= 0 ? 0 : Math.max(h, (percent / 100) * w)
  const id = `g${Math.round(percent)}${tone.main.slice(1)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">`
    + `<stop offset="0" stop-color="${tone.light}"/><stop offset="1" stop-color="${tone.main}"/>`
    + `</linearGradient></defs>`
    + `<rect width="${w}" height="${h}" rx="${r}" fill="#8b8b8b" fill-opacity="0.22"/>`
    + (fw > 0 ? `<rect width="${fw.toFixed(1)}" height="${h}" rx="${r}" fill="url(#${id})"/>` : '')
    + `</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const u = await $.session.usage()
    await update($, usage, () => toSnapshot(u.rateLimits))
    await fetchFable($, true)
    const t = await $.clock.now()
    await update($, now, () => t)
    // Keep the reset countdowns moving while the session sits idle.
    $.clock.every(30_000, () => {
      void $.clock.now().then(t => update($, now, () => t))
      void fetchFable($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, prev => {
      const s = toSnapshot(e.rateLimits)
      // Keep the last known rate limits when a measurement carries none.
      return {
        fiveHour: s.fiveHour ?? prev?.fiveHour,
        sevenDay: s.sevenDay ?? prev?.sevenDay,
        fable: prev?.fable,
      }
    })
    void fetchFable($)
    const t = await $.clock.now()
    await update($, now, () => t)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, usage)
    if (e.props.hasSurvey || !snap) return next(e)

    const nowMs = (await read($, now)) || (await $.clock.now())
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined

    const gauge = (label: string, percent: number | undefined, resetsAt?: string) => {
      if (percent === undefined) return null
      const p = Math.max(0, Math.min(100, Math.round(percent)))
      const tone = toneFor(p)
      const left = remaining(resetsAt, nowMs)
      const meter = Svg
        ? <Svg source={pill(p, tone)} alt={`${label} ${p}%`} width={88} height={8} />
        : (() => {
            const { filled, track } = bar(p)
            return <Text><Text color={tone.main}>{filled}</Text><Text dimColor>{track}</Text></Text>
          })()
      return (
        <Box key={label} flexDirection="row" alignItems="center" gap={1} marginRight={3}>
          <Text dimColor bold>{label}</Text>
          {meter}
          <Text color={tone.main} bold>{p}%</Text>
          {left ? <Text dimColor>· {left}</Text> : null}
        </Box>
      )
    }

    const items = [
      gauge('5h', snap.fiveHour?.percent, snap.fiveHour?.resetsAt),
      gauge('7d', snap.sevenDay?.percent, snap.sevenDay?.resetsAt),
      gauge('Fable', snap.fable?.percent, snap.fable?.resetsAt),
    ].filter(Boolean)
    if (items.length === 0) return next(e)

    return <Box flexDirection="row" alignItems="center" flexWrap="wrap">{items}</Box>
  })
}
