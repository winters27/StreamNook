import { useAppStore, SettingsTab } from '../stores/AppStore';
import {
  X,
  Layout,
  PlayCircle,
  MessageSquare,
  Palette,
  Plug,
  Bell,
  Database,
  Command,
  Keyboard,
  HelpCircle,
  Sparkles,
  Shield,
  User,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import InterfaceSettings from './settings/InterfaceSettings';
import PlayerSettings from './settings/PlayerSettings';
import ChatSettings from './settings/ChatSettings';
import ModerationSettings from './settings/ModerationSettings';
import ThemeSettings from './settings/ThemeSettings';
import IntegrationsSettings from './settings/IntegrationsSettings';
import CacheSettings from './settings/CacheSettings';
import NotificationsSettings from './settings/NotificationsSettings';
import SupportSettings from './settings/SupportSettings';
import WhatsNewSettings from './settings/WhatsNewSettings';
import CommandPaletteSettings from './settings/CommandPaletteSettings';
import KeybindingsSettings from './settings/KeybindingsSettings';
import ProfileSettings from './settings/ProfileSettings';
import SettingsSearchResults from './settings/SettingsSearchResults';
import type { SettingsIndexEntry } from './settings/searchIndex';
import { Tooltip } from './ui/Tooltip';

type TabMeta = {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
  tint: string;
  description: string;
};

const TABS: TabMeta[] = [
  { id: 'Player',          label: 'Player',          icon: PlayCircle,    tint: 'rgba(120, 155, 200, 0.22)', description: 'Streamlink, video player, and auto-switch' },
  { id: 'Chat',            label: 'Chat',            icon: MessageSquare, tint: 'rgba(150, 160, 210, 0.22)', description: 'Chat design, behavior, and pop-out' },
  { id: 'Moderation',      label: 'Moderation',      icon: Shield,        tint: 'rgba(210, 140, 140, 0.22)', description: 'Mod logs, visibility, and mass actions' },
  { id: 'Interface',       label: 'Interface',       icon: Layout,        tint: 'rgba(140, 195, 170, 0.22)', description: 'Sidebar, compact mode, and chrome' },
  { id: 'Theme',           label: 'Theme',           icon: Palette,       tint: 'rgba(220, 145, 175, 0.20)', description: 'Color theme and theme editor' },
  { id: 'Integrations',    label: 'Integrations',    icon: Plug,          tint: 'rgba(180, 150, 210, 0.22)', description: 'Twitch ad blocker and third-party services' },
  { id: 'Notifications',   label: 'Notifications',   icon: Bell,          tint: 'rgba(220, 180, 120, 0.20)', description: 'Toasts, sounds, and update prompts' },
  { id: 'Cache',           label: 'Cache',           icon: Database,      tint: 'rgba(150, 170, 185, 0.22)', description: 'Emote, badge, and metadata caches' },
  { id: 'Command Palette', label: 'Command Palette', icon: Command,       tint: 'rgba(140, 200, 180, 0.22)', description: 'The Ctrl+K palette and snippets' },
  { id: 'Keybindings',     label: 'Keybindings',     icon: Keyboard,      tint: 'rgba(190, 160, 205, 0.22)', description: 'Customizable keyboard shortcuts' },
  { id: 'Support',         label: 'Support',         icon: HelpCircle,    tint: 'rgba(215, 165, 140, 0.22)', description: 'Logs, diagnostics, and feedback' },
  { id: "What's New",      label: "What's New",      icon: Sparkles,      tint: 'rgba(225, 195, 130, 0.20)', description: 'Recent releases and changelog' },
];

// Profile is special — surfaced as the avatar pill at the top of the sidebar,
// not as a regular tab row. Hero treatment still uses the standard tile recipe
// so the right pane reads consistently with every other tab.
const PROFILE_META: TabMeta = {
  id: 'Profile',
  label: 'Profile',
  icon: User,
  tint: 'rgba(140, 195, 205, 0.22)',
  description: 'Account, identity, and 7TV cosmetics',
};

const TILE_BEVEL =
  'inset 1px 1px 0 0 rgba(255,255,255,0.10), inset -1px -1px 0 0 rgba(0,0,0,0.18)';
const HERO_BEVEL =
  'inset 1px 1px 0 0 rgba(255,255,255,0.14), inset -1px -1px 0 0 rgba(0,0,0,0.22), 0 4px 10px rgba(0,0,0,0.18)';

const SettingsDialog = () => {
  const { isSettingsOpen, settingsInitialTab, closeSettings, isAuthenticated, currentUser } = useAppStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('Player');
  const [searchQuery, setSearchQuery] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const tabs = TABS;
  const activeMeta =
    activeTab === 'Profile' ? PROFILE_META : tabs.find((t) => t.id === activeTab) ?? tabs[0];
  const HeroIcon = activeMeta.icon;
  const profileActive = activeTab === 'Profile';
  const searching = searchQuery.trim().length > 0;

  useEffect(() => {
    if (settingsInitialTab) {
      queueMicrotask(() => setActiveTab(settingsInitialTab));
    }
  }, [settingsInitialTab]);

  useEffect(() => {
    if (!isSettingsOpen) {
      queueMicrotask(() => {
        setActiveTab('Player');
        setSearchQuery('');
      });
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: 0 });
    }
  }, [activeTab, searching]);

  const selectTab = (tab: SettingsTab) => {
    setSearchQuery('');
    setActiveTab(tab);
  };

  const handleResultSelect = (entry: SettingsIndexEntry) => {
    setSearchQuery('');
    setActiveTab(entry.tab as SettingsTab);
    if (!entry.sectionId) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(entry.sectionId!);
        if (el && contentRef.current) {
          const containerTop = contentRef.current.getBoundingClientRect().top;
          const elTop = el.getBoundingClientRect().top;
          contentRef.current.scrollBy({
            top: elTop - containerTop - 8,
            behavior: 'smooth',
          });
        }
      });
    });
  };

  return (
    <AnimatePresence>
      {isSettingsOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xl"
          onClick={closeSettings}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="liquid-glass-panel flex w-[94vw] md:w-[90vw] lg:w-[86vw] xl:w-[82vw] max-w-[1480px] h-[90vh] max-h-[980px] overflow-hidden"
          >
            <aside className="flex w-[240px] flex-shrink-0 flex-col border-r border-white/[0.06] py-3">
              <div className="px-2">
                <button
                  type="button"
                  onClick={() => selectTab('Profile')}
                  className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                    profileActive && !searching
                      ? 'bg-white/[0.06] text-textPrimary'
                      : 'text-textSecondary hover:bg-white/[0.03] hover:text-textPrimary'
                  }`}
                >
                  {isAuthenticated && currentUser?.profile_image_url ? (
                    <img
                      // Twitch returns the upload at variants like
                      // {id}-profile_image-{size}x{size}.png. Force the
                      // 300x300 variant so a 32-px render has plenty of
                      // source pixels to downscale cleanly. The regex is a
                      // no-op if the URL doesn't match that shape.
                      src={currentUser.profile_image_url.replace(
                        /-(28x28|50x50|70x70|150x150)\./,
                        '-300x300.',
                      )}
                      alt=""
                      width={32}
                      height={32}
                      className="h-8 w-8 flex-shrink-0 rounded-full object-cover ring-1 ring-white/10"
                      // translateZ lifts the avatar to its own compositor
                      // layer so the parent liquid-glass-panel's heavy
                      // backdrop-filter doesn't soften the render.
                      // image-rendering hint nudges Chromium toward a
                      // crisper downscale algorithm at this aggressive ratio.
                      style={{
                        transform: 'translateZ(0)',
                        imageRendering: '-webkit-optimize-contrast' as unknown as 'auto',
                      }}
                    />
                  ) : (
                    <span
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: PROFILE_META.tint,
                        boxShadow: TILE_BEVEL,
                        border: '1px solid transparent',
                      }}
                    >
                      <User size={14} strokeWidth={2.25} className="text-textPrimary" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-textPrimary">
                      {isAuthenticated && currentUser
                        ? currentUser.display_name || currentUser.login
                        : 'Not signed in'}
                    </div>
                    <div className="truncate text-[11px] text-textMuted">
                      {isAuthenticated && currentUser
                        ? `@${currentUser.login}`
                        : 'Sign in with Twitch'}
                    </div>
                  </div>
                </button>
              </div>
              <div className="my-3 mx-4 border-b border-white/[0.06]" />
              <div className="px-3 pb-3">
                <div className="relative">
                  <Search
                    size={13}
                    strokeWidth={2.25}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textMuted"
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search settings"
                    className="w-full rounded-md border border-white/[0.06] bg-white/[0.03] py-1.5 pl-7 pr-7 text-[12px] text-textPrimary placeholder:text-textMuted focus:border-white/[0.12] focus:bg-white/[0.05] focus:outline-none"
                  />
                  {searching && (
                    <button
                      onClick={() => {
                        setSearchQuery('');
                        searchInputRef.current?.focus();
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-textMuted hover:bg-white/[0.06] hover:text-textPrimary"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
              <div className="px-4 pb-3">
                <span className="text-[11px] uppercase tracking-[0.12em] text-textMuted">
                  Settings
                </span>
              </div>
              <nav className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto px-2">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id && !searching;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => selectTab(tab.id)}
                      className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${
                        isActive
                          ? 'bg-white/[0.06] text-textPrimary'
                          : 'text-textSecondary hover:bg-white/[0.03] hover:text-textPrimary'
                      }`}
                    >
                      <span
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
                        style={{
                          background: tab.tint,
                          boxShadow: TILE_BEVEL,
                          border: '1px solid transparent',
                        }}
                      >
                        <Icon size={14} strokeWidth={2.25} className="text-textPrimary" />
                      </span>
                      <span className="text-[13px] font-medium">{tab.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-end px-3 pt-3">
                <Tooltip content="Close" delay={200} side="bottom">
                  <button
                    onClick={closeSettings}
                    className="rounded p-1.5 text-textMuted transition-colors hover:bg-white/[0.06] hover:text-textPrimary"
                  >
                    <X size={16} />
                  </button>
                </Tooltip>
              </div>

              <div className="flex items-center gap-3 px-8 pb-3 pt-0">
                <span
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: searching ? 'rgba(180, 180, 195, 0.18)' : activeMeta.tint,
                    boxShadow: HERO_BEVEL,
                    border: '1px solid transparent',
                  }}
                >
                  {searching ? (
                    <Search size={18} strokeWidth={2} className="text-textPrimary" />
                  ) : (
                    <HeroIcon size={18} strokeWidth={2} className="text-textPrimary" />
                  )}
                </span>
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold leading-tight text-textPrimary">
                    {searching ? 'Search' : activeMeta.label}
                  </h2>
                  <p className="mt-0.5 truncate text-[11px] text-textMuted">
                    {searching ? `Results for "${searchQuery}"` : activeMeta.description}
                  </p>
                </div>
                {/* Portal target for tab-specific actions. Tabs that want
                    to surface controls in the dialog hero (e.g. Profile's
                    share buttons) render into this slot via createPortal.
                    ml-auto pushes it to the right edge of the hero flex
                    row so it sits opposite the icon+title block, NOT
                    inside the scrolling content pane below. */}
                <div
                  id="settings-hero-actions"
                  className="ml-auto flex items-center gap-1"
                />
              </div>

              <div
                ref={contentRef}
                className="scrollbar-thin flex-1 overflow-y-auto px-8 pb-8"
              >
                {searching ? (
                  <SettingsSearchResults
                    query={searchQuery}
                    onSelect={handleResultSelect}
                  />
                ) : (
                  <>
                    {activeTab === 'Profile' && <ProfileSettings />}
                    {activeTab === 'Interface' && <InterfaceSettings />}
                    {activeTab === 'Player' && <PlayerSettings />}
                    {activeTab === 'Chat' && <ChatSettings />}
                    {activeTab === 'Moderation' && <ModerationSettings />}
                    {activeTab === 'Theme' && <ThemeSettings />}
                    {activeTab === 'Integrations' && <IntegrationsSettings />}
                    {activeTab === 'Notifications' && <NotificationsSettings />}
                    {activeTab === 'Cache' && <CacheSettings />}
                    {activeTab === 'Command Palette' && <CommandPaletteSettings />}
                    {activeTab === 'Keybindings' && <KeybindingsSettings />}
                    {activeTab === 'Support' && <SupportSettings />}
                    {activeTab === "What's New" && <WhatsNewSettings />}
                  </>
                )}
              </div>
            </section>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SettingsDialog;
