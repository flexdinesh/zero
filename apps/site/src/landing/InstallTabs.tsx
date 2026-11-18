'use client'

import { Fragment, useState } from 'react'
import { installMethods, links } from './links'

/** Breaks a command between words and after a URL's slashes, never inside a flag like `--`. */
function CommandText({ command }: { command: string }) {
  return (
    <>
      {command.split(' ').map((word, w) => (
        <Fragment key={w}>
          {w > 0 && ' '}
          {word.includes('/') ? (
            word.split('/').map((part, p) => (
              <Fragment key={p}>
                {p > 0 && '/'}
                {p > 0 && part !== '' && <wbr />}
                {part}
              </Fragment>
            ))
          ) : (
            <span className="landing-install-word">{word}</span>
          )}
        </Fragment>
      ))}
    </>
  )
}

export function InstallTabs() {
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const method = installMethods[selected] ?? installMethods[0]
  if (method === undefined) return null

  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="landing-install">
      <div className="landing-install-tabs" role="tablist" aria-label="Install method">
        {installMethods.map((m, index) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={index === selected}
            className="landing-install-tab"
            onClick={() => {
              setSelected(index)
              setCopied(false)
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="landing-install-command" role="tabpanel">
        <code>
          <span className="landing-install-prompt" aria-hidden="true">
            $
          </span>
          <span className="landing-install-text">
            <CommandText command={method.command} />
          </span>
        </code>
        <button type="button" className="landing-install-copy" onClick={() => void copy(method.command)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="landing-install-note">
        If <code>zero</code> is taken, confirm <code>zero-cli</code> in your terminal or choose <code>--name</code>.{' '}
        <a href={`${links.getStarted}#command-name-collisions`}>Install details</a>
      </p>
    </div>
  )
}
