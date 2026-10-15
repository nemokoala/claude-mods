import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const enabled = atom({ plugin: 'pretty-replies', key: 'enabled' } as const, true)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pretty',
      description: 'Toggle the pretty reply style (on | off)',
      argumentHint: '[on|off]',
    })
    const saved = await $.store.get('enabled')
    if (typeof saved === 'boolean') await update($, enabled, () => saved)

    return next(e)
  })

  on('command.run', { command: 'pretty' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = await update($, enabled, now =>
      arg === 'on' ? true : arg === 'off' ? false : !now,
    )
    await $.store.set('enabled', isOn)

    return { text: `Pretty replies ${isOn ? 'on' : 'off'}.` }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !(await read($, enabled))) return next(e)
    const { Box, Markdown } = $.ui.resolve(e)

    return (
      <Box
        borderStyle="quote"
        borderColor={e.props.isFirstOfReply ? 'claude' : 'subtle'}
        paddingLeft={1}
      >
        <Markdown text={e.props.text} />
      </Box>
    )
  })
}
