import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SEP = '\x1f'

// What `git` prints in a repository with one commit on main.
function gitOutput(args: readonly string[]): string {
  const cmd = args.join(' ')
  if (cmd.includes('--show-toplevel')) return '/repo\n'
  if (cmd.includes('--abbrev-ref')) return 'main\n'
  if (cmd.includes('--verify')) return 'abc1234\n'
  if (cmd.includes('--graph')) return '* abc1234 (HEAD -> main) init\n'
  if (cmd.startsWith('log')) return ['abc1234', '', 'HEAD -> main', 'init', 'me', '1 minute ago'].join(SEP) + '\n'
  return ''
}

// The engine beneath the plugin: that repository, and panes that open as asked.
function engine(on: On) {
  const opened: string[] = []
  const clock = mock.clock(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }))
  on('process.run', async (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: gitOutput(e.argv.slice(e.argv.indexOf('git') + 1)),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({
    value: opened.map(id => ({ id, title: 'Git graph', isShown: true, isFocused: false, isPlaced: true })),
  }))
  return { opened, clock }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the pane waits for /git-graph and opens with the graph showing`, async ($, on) => {
    const { opened, clock } = engine(on)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    await clock.advance(10_000)
    expect(opened).toEqual([])

    await $.command.run({
      command: 'git-graph',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(opened).toEqual(['git-graph'])

    const ui = await $.ui.mount({
      plugin: 'git-graph',
      surface,
      component: 'Pane',
      requestId: 'git-graph',
      props: { title: 'Git graph', isFocused: false, bodyColumns: 60 },
    })
    expect((await ui.find({ key: 'toggle' }))?.props.label).toBe('▾')
    expect(await ui.find({ key: 'more' })).toBeDefined()
  })
}
