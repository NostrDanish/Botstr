import { useEffect, useState } from 'react'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import { Bot, ExternalLink, Plus } from 'lucide-react'
import Home from './pages/Home'
import NewBot from './pages/NewBot'
import BotDetail from './pages/BotDetail'
import { manager } from './lib/runtime'
import { cn } from './components/ui'

export default function App() {
  const [cloud, setCloud] = useState(false)
  useEffect(() => {
    void manager.whenReady().then(() => setCloud(manager.cloudEnabled()))
  }, [])

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2.5">
            <img src="./favicon.svg" alt="Botstr" className="h-7 w-7" />
            <span className="text-lg font-bold tracking-tight">
              BOTSTR <span className="text-accent">_</span>
            </span>
          </Link>
          <span
            className={cn(
              'hidden rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider sm:inline',
              cloud ? 'border-accent/40 text-accent' : 'border-border text-muted',
            )}
          >
            {cloud ? 'cloud runtime connected' : 'browser runtime'}
          </span>
          <nav className="ml-auto flex items-center gap-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                cn('rounded-lg px-3 py-1.5 text-sm', isActive ? 'text-text' : 'text-muted hover:text-text')
              }
            >
              Bot Nodes
            </NavLink>
            <Link to="/new">
              <span className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-dim">
                <Plus size={15} /> Deploy Node
              </span>
            </Link>
            <a
              href="https://github.com/NostrDanish/Botstr"
              target="_blank"
              rel="noreferrer"
              className="ml-2 flex items-center gap-1 rounded-lg px-2 py-2 text-xs text-muted hover:text-text"
              title="Source on GitHub"
            >
              Source <ExternalLink size={14} />
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewBot />} />
          <Route path="/bot/:id" element={<BotDetail />} />
          <Route
            path="*"
            element={
              <div className="flex flex-col items-center gap-3 py-24 text-muted">
                <Bot size={32} />
                <p>Nothing here.</p>
              </div>
            }
          />
        </Routes>
      </main>

      <footer className="border-t border-border py-5">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-xs text-muted">
          <span>Botstr — open infrastructure for Nostr bots. MIT.</span>
          <a href="https://shakespeare.diy" target="_blank" rel="noreferrer" className="hover:text-text">
            Vibed with Shakespeare
          </a>
        </div>
      </footer>
    </div>
  )
}
