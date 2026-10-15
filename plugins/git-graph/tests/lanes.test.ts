import { expect, test } from 'claude-code/testing'

import type { Commit, Graph } from '../types'
import { laneView, svgGraph } from '../hooks/register'

const commit = (sha: string, parents: string[]): Commit =>
  ({ sha, parents, refs: [], subject: sha, author: 'a', when: 'now' })

// `n` branch tips, each one commit off a shared root: `n` lanes side by side.
function fan(n: number): Graph {
  const tips = Array.from({ length: n }, (_, i) => commit(`tip${i}`, ['root']))
  return { root: '/r', branch: 'main', commits: [...tips, commit('root', [])], ascii: [], changes: null }
}

test('a few lanes keep the old spacing and are all drawn', () => {
  expect(laneView(3, 800)).toEqual({ laneW: 14, visible: 3 })
  const view = svgGraph(fan(3), 800)
  expect(view.lanes).toBe(3)
  expect(view.visible).toBe(3)
  expect(view.source).not.toContain('url(#lanes)')
})

test('lanes draw closer together as there are more of them', () => {
  expect(laneView(8, 2000).laneW).toBe(12)
  expect(laneView(20, 2000).laneW).toBe(10)
})

test('the graph area is capped and the rest is clipped', () => {
  const view = svgGraph(fan(30), 1000)
  expect(view.lanes).toBe(30)
  expect(view.visible).toBe(14)
  expect(view.offset).toBe(0)
  expect(view.source).toContain('mask="url(#lanes)"')
  expect(view.source).toContain('url(#fadeR)')
  expect(view.source).not.toContain('url(#fadeL)')
})

test('a narrow pane still shows a few lanes', () => {
  expect(laneView(30, 360).visible).toBe(9)
  expect(laneView(30, 120).visible).toBe(4)
})

test('panning moves the window and stops at the last lane', () => {
  const mid = svgGraph(fan(30), 1000, 5)
  expect(mid.offset).toBe(5)
  expect(mid.source).toContain('url(#fadeL)')
  expect(mid.source).toContain('url(#fadeR)')
  const end = svgGraph(fan(30), 1000, 99)
  expect(end.offset).toBe(30 - 14)
  expect(end.source).not.toContain('url(#fadeR)')
})
