import { describe, expect, mock, test } from 'claude-code/testing'

const REPLY = { text: '## 결론\n\n- 하나\n- 둘', isFirstOfReply: true }

describe('pretty-replies', () => {
  test('wraps a reply in a themed left bar', async $ => {
    const ui = await $.ui.mount({
      plugin: 'pretty-replies',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: REPLY,
    })

    expect(await ui.drawn()).toMatchObject({
      type: 'Box',
      props: { borderStyle: 'quote', borderColor: 'claude', paddingLeft: 1 },
    })
    expect(await ui.find({ type: 'Markdown', text: '## 결론' })).toBeDefined()
  })

  test('dims the bar on a block after a tool call', async $ => {
    const ui = await $.ui.mount({
      plugin: 'pretty-replies',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { ...REPLY, isFirstOfReply: false },
    })

    expect(await ui.drawn()).toMatchObject({ props: { borderColor: 'subtle' } })
  })

  test('/pretty off draws the engine reply again', async ($, on) => {
    mock.store(on)
    on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine reply</Text>
    })
    const ui = await $.ui.mount({
      plugin: 'pretty-replies',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: REPLY,
    })
    const ran = await $.command.run({
      command: 'pretty',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })

    expect(ran).toMatchObject({ text: 'Pretty replies off.' })
    expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['engine reply'] })
  })

})
