import { useState } from 'react'
import {
  connectionView,
  platforms,
  type PlatformId,
} from './platformCatalog'
import type { GuestConnection } from './guestConnections'
import { backendScope } from './taskApi'
import { SocialAccountOptions } from './SocialAccounts'

export function ConnectedApps({
  signedIn,
  ready,
  youtube,
  busy,
  error,
  onConnect,
  onDisconnect,
  onRefresh,
  onNeedLogin,
}: {
  signedIn: boolean
  ready: boolean
  youtube: GuestConnection | null
  busy: boolean
  error: string
  onConnect: () => void
  onDisconnect: () => void
  onRefresh: () => void
  onNeedLogin: () => void
}) {
  const [open, setOpen] = useState<PlatformId | null>(null)
  return (
    <section className="connected-apps">
      <span className="eyebrow">CONNECTED APPS</span>
      <h1>连接应用</h1>
      <p>
        连接你的内容平台，让 Spur 更了解你的创作，并在获得授权后帮助你分析数据和执行任务。
      </p>
      {!backendScope.startsWith('guest:') && <section className="app-card social-connections" aria-label="Social network accounts">
        <div className="app-card-head">
          <strong>Social network accounts</strong>
          <a className="secondary-button" href="#memory/social">Open social network ↗</a>
        </div>
        <SocialAccountOptions />
      </section>}
      <div className="app-grid">
        {platforms.filter(platform => platform.id !== 'instagram' || backendScope.startsWith('guest:')).map((platform) => {
          const view = connectionView(platform.id, youtube, signedIn, ready)
          const manageable = view.state === 'connected' || view.state === 'reconnect'
          return (
            <article className="app-card" key={platform.id}>
              <div className="app-card-head">
                <span className={'app-mark mark-' + platform.id}>{platform.mark}</span>
                <div>
                  <strong>{platform.name}</strong>
                  <small className={'app-state state-' + view.state}>{view.label}</small>
                </div>
              </div>
              <p>{platform.description}</p>
              {view.account && <p className="app-account">{view.account}</p>}
              {platform.id === 'youtube' && error && (
                <p className="task-error" role="alert">{error}</p>
              )}
              {view.state === 'soon' ? (
                <button className="secondary-button" type="button" disabled>
                  即将支持
                </button>
              ) : view.state === 'loading' ? (
                <button className="secondary-button" type="button" disabled>
                  正在读取…
                </button>
              ) : view.state === 'unavailable' ? (
                <button className="secondary-button" type="button" onClick={onRefresh}>
                  重新读取
                </button>
              ) : !signedIn ? (
                <button className="secondary-button" type="button" onClick={onNeedLogin}>
                  输入邀请码后连接
                </button>
              ) : manageable ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setOpen(open === platform.id ? null : platform.id)}
                >
                  {open === platform.id ? '收起' : '管理连接'}
                </button>
              ) : (
                <button className="secondary-button" type="button" disabled={busy} onClick={onConnect}>
                  {busy ? '正在打开授权…' : '连接账号'}
                </button>
              )}
              {open === platform.id && manageable && (
                <div className="app-manage">
                  <p>
                    {platform.name}
                    {view.account ? ' · ' + view.account : ''}
                    {' · '}
                    {view.label}
                  </p>
                  <div>
                    <button className="secondary-button" type="button" disabled={busy} onClick={onConnect}>
                      {busy ? '正在打开授权…' : '重新连接'}
                    </button>
                    <button className="secondary-button" type="button" disabled={busy} onClick={onDisconnect}>
                      {busy ? '正在断开…' : '断开连接'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
