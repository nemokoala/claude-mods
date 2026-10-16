import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Changes, Commit, Graph, GraphError } from '../types'

const PANE = 'git-graph'
const repo = atom({ plugin: 'git-graph', key: 'repo' } as const, null)
// The pane opens only on /git-graph, and opens with the graph showing.
const isCollapsed = atom({ plugin: 'git-graph', key: 'isCollapsed' } as const, false)
const limit = atom({ plugin: 'git-graph', key: 'limit' } as const, 40)
const graph = atom({ plugin: 'git-graph', key: 'graph' } as const, null)
const laneOffset = atom({ plugin: 'git-graph', key: 'laneOffset' } as const, 0)

const SEP = '\x1f'
const LANE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16']

async function git($: EngineInterface, dir: string | null, args: string[]) {
  const argv = dir ? ['git', '-C', dir, ...args] : ['git', ...args]
  // GIT_OPTIONAL_LOCKS=0: `status` must never take the index lock a git
  // command the person runs at the same moment needs.
  return $.process.run(argv, { timeoutMs: 15_000, env: { GIT_OPTIONAL_LOCKS: '0' } })
}

// The pseudo-commit standing for the working tree's uncommitted changes.
const WORKTREE = 'WORKTREE'

function countChanges(porcelain: string): Changes | null {
  const c: Changes = { staged: 0, unstaged: 0, untracked: 0 }
  for (const line of porcelain.split('\n')) {
    if (line.length < 3) continue
    const [x, y] = [line[0], line[1]]
    if (x === '?' && y === '?') { c.untracked++; continue }
    if (x !== ' ') c.staged++
    if (y !== ' ') c.unstaged++
  }
  return c.staged + c.unstaged + c.untracked > 0 ? c : null
}

function describeChanges(c: Changes): string {
  return [
    c.staged ? `스테이징 ${c.staged}` : '',
    c.unstaged ? `수정 ${c.unstaged}` : '',
    c.untracked ? `새 파일 ${c.untracked}` : '',
  ].filter(Boolean).join(' · ')
}

const POLL_MS = 3_000
const FULL_REFRESH_MS = 60_000
let lastSeen = ''
let lastFull = 0
let isPolling = false

// Where HEAD and every branch and tag point, and which files are changed:
// it moves on any commit, checkout, merge, rebase, reset, fetch, branch
// edit, or a file edited, staged or added.
async function fingerprint($: EngineInterface, dir: string | null): Promise<string> {
  const [refs, head, status] = await Promise.all([
    git($, dir, ['show-ref', '--head']),
    git($, dir, ['symbolic-ref', '-q', 'HEAD']),
    git($, dir, ['status', '--porcelain']),
  ])
  return refs.exitCode === 0 ? `${head.stdout}\n${refs.stdout}\n${status.stdout}` : ''
}

// Runs on a timer: redraws when the repository moved, and once a minute
// anyway so the "n minutes ago" times stay current.
async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function poll($: EngineInterface): Promise<void> {
  if (isPolling || !(await isOpen($))) return
  isPolling = true
  try {
    const g = await read($, graph)
    const dir = g && !('error' in g) ? g.root : await read($, repo)
    const isStale = (await $.clock.now()) - lastFull > FULL_REFRESH_MS
    if (isStale || (await fingerprint($, dir)) !== lastSeen) await refresh($)
  } catch {
    // A failed check just waits for the next tick.
  } finally {
    isPolling = false
  }
}

async function refresh($: EngineInterface): Promise<void> {
  lastFull = await $.clock.now()
  const dir = await read($, repo)
  lastSeen = await fingerprint($, dir).catch(() => '')
  const n = await read($, limit)
  let next: Graph | GraphError
  try {
    const top = await git($, dir, ['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) {
      next = { error: `${dir ?? '현재 폴더'}는 깃 저장소가 아니에요. /git-graph <경로> 로 저장소를 지정하세요.` }
    } else {
      const root = top.stdout.trim()
      const [head, headSha, log, ascii, status] = await Promise.all([
        git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git($, root, ['rev-parse', '-q', '--verify', 'HEAD']),
        git($, root, ['log', '--all', '--topo-order', '-n', String(n),
          `--format=%H${SEP}%P${SEP}%D${SEP}%s${SEP}%an${SEP}%ar`]),
        git($, root, ['log', '--all', '--graph', '--oneline', '--decorate', '-n', String(n)]),
        git($, root, ['status', '--porcelain']),
      ])
      const changes = countChanges(status.stdout)
      const commits: Commit[] = log.stdout.split('\n').filter(Boolean).map(line => {
        const [sha, parents, refs, subject, author, when] = line.split(SEP)
        return {
          sha,
          parents: parents ? parents.split(' ') : [],
          refs: refs ? refs.split(', ').filter(Boolean) : [],
          subject: subject ?? '',
          author: author ?? '',
          when: when ?? '',
        }
      })
      const asciiLines = ascii.stdout.split('\n').filter(Boolean)
      if (changes) {
        // Uncommitted work sits on top of HEAD, as its would-be child.
        const parent = headSha.exitCode === 0 ? headSha.stdout.trim() : ''
        commits.unshift({
          sha: WORKTREE,
          parents: parent ? [parent] : [],
          refs: [],
          subject: '커밋하지 않은 변경',
          author: describeChanges(changes),
          when: '',
        })
        asciiLines.unshift(`◌ 커밋하지 않은 변경 (${describeChanges(changes)})`)
      }
      next = {
        root,
        branch: head.stdout.trim(),
        commits,
        ascii: asciiLines,
        changes,
      }
    }
  } catch (err) {
    next = { error: `git 실행 실패: ${String(err)}` }
  }
  await update($, graph, () => next)
}

// ---- layout -------------------------------------------------------------

type Edge = { from: number; lane: number; to: number | null }

// Assigns each commit a lane and records, per parent link, which lane the
// line travels down in between the child's row and the parent's row.
function layout(commits: Commit[]) {
  const lanes: (string | null)[] = []
  const placed: number[] = []
  const edges: Edge[] = []
  const pending = new Map<string, Edge[]>()
  let width = 1

  const freeSlot = (avoid: number) => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i
    lanes.push(null)
    return lanes.length - 1
  }

  commits.forEach((c, row) => {
    let lane = lanes.indexOf(c.sha)
    if (lane === -1) lane = freeSlot(-1)
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) lanes[i] = null
    placed.push(lane)
    for (const e of pending.get(c.sha) ?? []) e.to = row
    pending.delete(c.sha)

    c.parents.forEach((p, idx) => {
      // The first parent always continues in this commit's lane, even when
      // another lane already heads for it: both lines meet at the parent.
      let k: number
      if (idx === 0 && lanes[lane] === null) {
        k = lane
        lanes[k] = p
      } else {
        k = lanes.indexOf(p)
        if (k === -1) {
          k = freeSlot(lane)
          lanes[k] = p
        }
      }
      const edge: Edge = { from: row, lane: k, to: null }
      edges.push(edge)
      pending.set(p, [...(pending.get(p) ?? []), edge])
    })
    width = Math.max(width, lanes.length, lane + 1)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
  })
  return { placed, edges, width }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const textWidth = (s: string, size: number) =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x1100 ? size : size * 0.56), 0)

function clip(s: string, maxW: number, size: number): string {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const PAD = 12
// The graph area never takes more than this, nor more than GRAPH_SHARE of the
// pane: lanes beyond it are panned to with ◀ ▶.
const GRAPH_MAX = 160
const GRAPH_SHARE = 0.3
const MIN_VISIBLE_LANES = 4

// Lanes draw closer together as there are more of them.
const laneSpacing = (lanes: number) => (lanes <= 6 ? 14 : lanes <= 10 ? 12 : 10)

// How far apart lanes are drawn and how many fit in the graph area at once.
export function laneView(lanes: number, W: number): { laneW: number; visible: number } {
  const laneW = laneSpacing(lanes)
  const maxW = Math.min(GRAPH_MAX, Math.round(W * GRAPH_SHARE))
  const fit = Math.max(MIN_VISIBLE_LANES, Math.floor((maxW - 2 * PAD) / laneW) + 1)
  return { laneW, visible: Math.min(lanes, fit) }
}

export type GraphView = {
  source: string
  height: number
  /** Lanes the whole history needs, how many are drawn, and the first drawn. */
  lanes: number
  visible: number
  offset: number
}

export function svgGraph(g: Graph, W: number, offset = 0): GraphView {
  const ROW = 28
  const FS = 12
  const { placed, edges, width } = layout(g.commits)
  const { laneW, visible } = laneView(width, W)
  const off = Math.max(0, Math.min(offset, width - visible))
  const H = g.commits.length * ROW + 6
  const x = (lane: number) => PAD + (lane - off) * laneW
  const y = (row: number) => 3 + row * ROW + ROW / 2
  const color = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]
  const dotR = laneW >= 14 ? 4.5 : 4
  const textX = PAD + visible * laneW + 8
  // The graph area's edges: lanes outside them are clipped and faded.
  const areaL = PAD - laneW / 2
  const areaR = PAD + (visible - 0.5) * laneW
  const hiddenLeft = off > 0
  const hiddenRight = off + visible < width
  const isClipped = hiddenLeft || hiddenRight
  const isInView = (lane: number) => lane >= off && lane < off + visible
  const lines: string[] = []
  const parts: string[] = []

  for (const e of edges) {
    const x1 = x(placed[e.from])
    const y1 = y(e.from)
    const half = ROW / 2
    let d = `M${x1} ${y1}`
    let cx = x1
    let cy = y1
    // One row's worth of S-curve from the current point over to lane x `nx`.
    const swing = (nx: number) => {
      d += ` C${cx} ${cy + half} ${nx} ${cy + half} ${nx} ${cy + ROW}`
      cx = nx
      cy += ROW
    }
    if (e.to !== null && e.to === e.from + 1) {
      swing(x(placed[e.to]))
    } else {
      swing(x(e.lane))
      if (e.to === null) {
        d += ` L${cx} ${H}`
      } else {
        const x2 = x(placed[e.to])
        const y2 = y(e.to)
        if (y2 - ROW > cy) { d += ` L${cx} ${y2 - ROW}`; cy = y2 - ROW }
        if (cy < y2) swing(x2)
      }
    }
    const dash = g.commits[e.from].sha === WORKTREE ? ' stroke-dasharray="3 3"' : ''
    lines.push(`<path d="${d}" stroke="${color(e.lane)}" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.9"${dash}/>`)
  }

  g.commits.forEach((c, row) => {
    const lane = placed[row] ?? 0
    const cx = x(lane)
    const cy = y(row)
    const col = color(lane)
    // A commit in a lane panned out of view: a marker at that edge, in its color.
    if (!isInView(lane)) {
      parts.push(lane < off
        ? `<path d="M1 ${cy} L6 ${cy - 4} L6 ${cy + 4} Z" fill="${col}"/>`
        : `<path d="M${areaR + 7} ${cy} L${areaR + 2} ${cy - 4} L${areaR + 2} ${cy + 4} Z" fill="${col}"/>`)
    }
    if (c.sha === WORKTREE) {
      lines.push(`<circle cx="${cx}" cy="${cy}" r="5.5" class="bg" stroke="${col}" stroke-width="2" stroke-dasharray="2.5 2"/>`)
      const tx = textX
      parts.push(`<text x="${tx}" y="${cy + 4}" class="wt">${esc(c.subject)}</text>`)
      parts.push(`<text x="${tx + textWidth(c.subject, FS) + 12}" y="${cy + 4}" class="meta">${esc(c.author)}</text>`)
      return
    }
    if (c.refs.some(r => r.startsWith('HEAD'))) {
      lines.push(`<circle cx="${cx}" cy="${cy}" r="6.5" class="bg" stroke="${col}" stroke-width="2.5"/>`)
      lines.push(`<circle cx="${cx}" cy="${cy}" r="2.5" fill="${col}"/>`)
    } else if (c.parents.length > 1) {
      lines.push(`<circle cx="${cx}" cy="${cy}" r="${dotR}" class="bg" stroke="${col}" stroke-width="2"/>`)
    } else {
      lines.push(`<circle cx="${cx}" cy="${cy}" r="${dotR}" fill="${col}"/>`)
    }

    let tx = textX
    const meta = `${c.author} · ${c.when}`
    const metaW = textWidth(meta, FS - 1)
    const right = W - PAD
    parts.push(`<text x="${tx}" y="${cy + 4}" class="sha">${c.sha.slice(0, 7)}</text>`)
    tx += 62

    for (const raw of c.refs.slice(0, 3)) {
      if (raw === 'HEAD') continue
      const isHeadRef = raw.startsWith('HEAD -> ')
      const isTag = raw.startsWith('tag: ')
      const label = isHeadRef ? raw.slice(8) : isTag ? raw.slice(5) : raw
      const kind = isHeadRef ? 'head' : isTag ? 'tag' : raw.includes('/') ? 'remote' : 'local'
      const bw = textWidth(label, FS - 1) + 14
      parts.push(`<rect x="${tx}" y="${cy - 9}" width="${bw}" height="18" rx="9" class="b-${kind}"/>`)
      parts.push(`<text x="${tx + 7}" y="${cy + 4}" class="t-${kind}">${esc(label)}</text>`)
      tx += bw + 5
    }

    const showMeta = right - metaW > tx + 80
    const room = (showMeta ? right - metaW - 12 : right) - tx
    if (room > 30) {
      parts.push(`<text x="${tx}" y="${cy + 4}" class="subj">${esc(clip(c.subject, room, FS))}</text>`)
    }
    if (showMeta) {
      parts.push(`<text x="${right}" y="${cy + 4}" text-anchor="end" class="meta">${esc(meta)}</text>`)
    }
  })

  const style = `<style>
    text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;font-size:${FS}px}
    .sha{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11px;fill:#8b949e}
    .subj{fill:#1f2328}.meta{fill:#6e7781;font-size:11px}.bg{fill:#ffffff}
    .wt{fill:#b45309;font-style:italic;font-weight:600}
    .b-head{fill:#3b82f6}.t-head{fill:#ffffff;font-size:11px;font-weight:600}
    .b-local{fill:#10b98126;stroke:#10b981}.t-local{fill:#047857;font-size:11px}
    .b-remote{fill:#8b949e22;stroke:#8b949e}.t-remote{fill:#57606a;font-size:11px}
    .b-tag{fill:#f59e0b26;stroke:#f59e0b}.t-tag{fill:#b45309;font-size:11px}
    @media (prefers-color-scheme: dark){
      .subj{fill:#e6edf3}.meta{fill:#8b949e}.bg{fill:#1e1e1e}.wt{fill:#fbbf24}
      .t-local{fill:#6ee7b7}.t-remote{fill:#c9d1d9}.t-tag{fill:#fcd34d}
    }
  </style>`
  // Lines and dots; clipped to the graph area, the cut edges faded out by a
  // mask (any background shows through) when some lanes are panned out of view.
  let graphArea = lines.join('')
  if (isClipped) {
    const FADE = 10
    const fadeL = hiddenLeft ? areaL + FADE : areaL
    const fadeR = hiddenRight ? areaR - FADE : areaR
    const defs = `<defs>
      <linearGradient id="fadeL"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
      <linearGradient id="fadeR"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
      <mask id="lanes" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
        ${hiddenLeft ? `<rect x="${areaL}" y="0" width="${FADE}" height="${H}" fill="url(#fadeL)"/>` : ''}
        <rect x="${fadeL}" y="0" width="${fadeR - fadeL}" height="${H}" fill="#fff"/>
        ${hiddenRight ? `<rect x="${fadeR}" y="0" width="${FADE}" height="${H}" fill="url(#fadeR)"/>` : ''}
      </mask>
    </defs>`
    graphArea = `${defs}<g mask="url(#lanes)">${graphArea}</g>`
  }
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style}${graphArea}${parts.join('')}</svg>`
  return { source, height: H, lanes: width, visible, offset: off }
}

// ---- hooks --------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'git-graph',
      description: '깃 그래프 패널 열기 (인자로 저장소 경로를 주면 그 저장소를 표시)',
    })
    // Polling and redraws only run while the pane is open (see poll).
    $.clock.every(POLL_MS, () => void poll($))
    return result
  })

  on('command.run', { command: 'git-graph' }, async ($, e) => {
    const arg = e.args.trim().replace(/^["']|["']$/g, '')
    if (arg) {
      await update($, repo, () => arg)
      await update($, laneOffset, () => 0)
    }
    await update($, isCollapsed, () => false)
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Git graph' })
    const g = await read($, graph)
    return { text: g && 'error' in g ? g.error : 'Git graph 패널을 열었어요.' }
  })

  // Commits and checkouts usually happen during a turn: redraw after each one.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (await isOpen($)) await refresh($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const g = await read($, graph)
    const collapsed = await read($, isCollapsed)

    const reload = <Button key="reload" hotkey="r" dimColor label="↻ 새로고침" onPress={() => refresh($)} />

    if (!g) return <Text dimColor>불러오는 중…</Text>
    if ('error' in g) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{g.error}</Text>
          <Box flexDirection="row">{reload}</Box>
        </Box>
      )
    }

    const head = g.commits.find(c => c.refs.some(r => r.startsWith('HEAD')))
    const name = g.root.split(/[\\/]/).pop() ?? g.root
    const header = (
      <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
        <Button
          key="toggle"
          hotkey="c"
          plain
          label={collapsed ? '▸' : '▾'}
          onPress={() => update($, isCollapsed, v => !v)}
        />
        <Text bold>{name}</Text>
        <Text color="#3b82f6" bold>⎇ {g.branch}</Text>
        {head ? <Text dimColor>{head.sha.slice(0, 7)}</Text> : null}
        <Box flexGrow={1} />
        {reload}
      </Box>
    )

    if (collapsed) {
      return (
        <Box flexDirection="column">
          {header}
          {g.changes ? (
            <Text color="#f59e0b" wrap="truncate-end">◌ 커밋하지 않은 변경 ({describeChanges(g.changes)})</Text>
          ) : null}
          {head ? <Text dimColor wrap="truncate-end">{head.subject}</Text> : null}
        </Box>
      )
    }

    const more = (
      <Button
        key="more"
        hotkey="m"
        dimColor
        label={`더 보기 (${g.commits.length}개 표시 중)`}
        onPress={async () => {
          await update($, limit, n => Math.min(n + 30, 300))
          await refresh($)
        }}
      />
    )

    if (Svg) {
      const W = Math.max(360, Math.min(1100, Math.round(e.props.bodyColumns * 7.5)))
      const { source, height, lanes, visible, offset } = svgGraph(g, W, await read($, laneOffset))
      const maxOff = lanes - visible
      const step = Math.max(1, Math.floor(visible / 2))
      const pan = (by: number) => update($, laneOffset, v => Math.max(0, Math.min(maxOff, Math.min(v, maxOff) + by)))
      // Only while some lanes do not fit: pan the graph area over them.
      const panner = maxOff > 0 ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="lanes-left" hotkey="h" dimColor={offset === 0} label="◀" onPress={() => pan(-step)} />
          <Text dimColor>레인 {offset + 1}–{offset + visible} / {lanes}</Text>
          <Button key="lanes-right" hotkey="l" dimColor={offset === maxOff} label="▶" onPress={() => pan(step)} />
        </Box>
      ) : null
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {panner}
          <Svg source={source} alt={`${name} 커밋 그래프, 최근 ${g.commits.length}개`} width={W} height={height} />
          <Box flexDirection="row">{more}</Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {g.ascii.map((line, i) => <Text key={`l${i}`} wrap="truncate-end">{line}</Text>)}
        <Box flexDirection="row">{more}</Box>
      </Box>
    )
  })
}
